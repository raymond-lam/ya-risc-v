/*
 * Copyright 2026 Raymond Lam
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { bytesToBigInt } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';
import type { Memory } from '#emulator/memory/types';

/** Guest-visible 16550 register window size (RBR/THR … SCR). */
const UART_REGISTER_WINDOW = 8;

/**
 * Bytes of ring storage per direction. One slot is reserved so head===tail means empty
 * and (tail+1)%CAP===head means full (classic circular buffer).
 */
const UART_QUEUE_CAPACITY = 16;

/** LSR: receiver data ready. */
const LSR_DR = 0x01;
/** LSR: transmitter holding register empty (room to accept a TX byte). */
const LSR_THRE = 0x20;
/** LSR: transmitter empty (TX queue empty). */
const LSR_TEMT = 0x40;

/** Byte offsets into queue meta: rxHead, rxTail, txHead, txTail. */
const META_RX_HEAD = 0;
const META_RX_TAIL = 1;
const META_TX_HEAD = 2;
const META_TX_TAIL = 3;
/** Host bytes reserved for UART queue head/tail indices. */
const META_BYTE_COUNT = 4;

/** Host Int32 wake word for the terminal TX pump (`Atomics.wait` / `notify`). */
const UART_TX_WAKE_HOST_SIZE = 4;

const uartTxWakeWords = (memory: Memory): Int32Array =>
  new Int32Array(memory.bytes.buffer, memory.uartTxWakeHostIndex, 1);

/** Notify the terminal worker that the TX ring may have become nonempty. */
const notifyUartTransmit = (memory: Memory): void => {
  const wake = uartTxWakeWords(memory);
  Atomics.add(wake, 0, 1);
  Atomics.notify(wake, 0);
};

/**
 * Wait until the UART TX ring may have data (`Atomics.waitAsync` on the TX wake word).
 * Re-checks emptiness after snapshotting the wake epoch so a concurrent THR store
 * cannot strand the waiter. Async so the terminal worker's event loop (web streams)
 * can keep running.
 */
const waitUartTransmit = async (memory: Memory): Promise<void> => {
  const wake = uartTxWakeWords(memory);
  const expected = Atomics.load(wake, 0);
  const head = Atomics.load(memory.bytes, metaIndex(memory, META_TX_HEAD));
  const tail = Atomics.load(memory.bytes, metaIndex(memory, META_TX_TAIL));
  if (head !== tail) {
    return;
  }
  const result = Atomics.waitAsync(wake, 0, expected);
  if (result.async) {
    await result.value;
  }
};

/**
 * Map a guest UART address to a register index within the 8-byte window (0..7),
 * or `null` if the address is outside the window.
 */
const uartAddressToRegisterIndex = (memory: Memory, address: ReadonlyUint8Array): number | null => {
  const guestAddress = bytesToBigInt(address);
  const uartBase = bytesToBigInt(memory.uartBaseAddress);
  const uartEnd = uartBase + BigInt(UART_REGISTER_WINDOW);
  if (guestAddress >= uartBase && guestAddress < uartEnd) {
    return Number(guestAddress - uartBase);
  }
  return null;
};

const metaIndex = (memory: Memory, offset: number): number => memory.uartMetaHostIndex + offset;

const queueLength = (head: number, tail: number): number =>
  (tail - head + UART_QUEUE_CAPACITY) % UART_QUEUE_CAPACITY;

const queueIsFull = (head: number, tail: number): boolean =>
  (tail + 1) % UART_QUEUE_CAPACITY === head;

/**
 * Host/keyboard: enqueue a received byte. Returns false if the RX ring is full (byte dropped).
 */
const pushUartReceive = (memory: Memory, value: number): boolean => {
  const head = Atomics.load(memory.bytes, metaIndex(memory, META_RX_HEAD));
  const tail = Atomics.load(memory.bytes, metaIndex(memory, META_RX_TAIL));
  if (queueIsFull(head, tail)) {
    return false;
  }
  memory.bytes[memory.uartRxDataHostIndex + tail] = value & 0xff;
  Atomics.store(memory.bytes, metaIndex(memory, META_RX_TAIL), (tail + 1) % UART_QUEUE_CAPACITY);
  return true;
};

/**
 * Host: dequeue a transmitted byte. Returns `null` if the TX ring is empty.
 */
const popUartTransmit = (memory: Memory): number | null => {
  const head = Atomics.load(memory.bytes, metaIndex(memory, META_TX_HEAD));
  const tail = Atomics.load(memory.bytes, metaIndex(memory, META_TX_TAIL));
  if (head === tail) {
    return null;
  }
  const value = memory.bytes[memory.uartTxDataHostIndex + head] ?? 0;
  Atomics.store(memory.bytes, metaIndex(memory, META_TX_HEAD), (head + 1) % UART_QUEUE_CAPACITY);
  return value;
};

const popReceive = (memory: Memory): number => {
  const head = Atomics.load(memory.bytes, metaIndex(memory, META_RX_HEAD));
  const tail = Atomics.load(memory.bytes, metaIndex(memory, META_RX_TAIL));
  if (head === tail) {
    return 0;
  }
  const value = memory.bytes[memory.uartRxDataHostIndex + head] ?? 0;
  Atomics.store(memory.bytes, metaIndex(memory, META_RX_HEAD), (head + 1) % UART_QUEUE_CAPACITY);
  return value;
};

const pushTransmit = (memory: Memory, value: number): boolean => {
  const head = Atomics.load(memory.bytes, metaIndex(memory, META_TX_HEAD));
  const tail = Atomics.load(memory.bytes, metaIndex(memory, META_TX_TAIL));
  if (queueIsFull(head, tail)) {
    return false;
  }
  const wasEmpty = head === tail;
  memory.bytes[memory.uartTxDataHostIndex + tail] = value & 0xff;
  Atomics.store(memory.bytes, metaIndex(memory, META_TX_TAIL), (tail + 1) % UART_QUEUE_CAPACITY);
  if (wasEmpty) {
    notifyUartTransmit(memory);
  }
  return true;
};

const readLineStatus = (memory: Memory): number => {
  const rxHead = Atomics.load(memory.bytes, metaIndex(memory, META_RX_HEAD));
  const rxTail = Atomics.load(memory.bytes, metaIndex(memory, META_RX_TAIL));
  const txHead = Atomics.load(memory.bytes, metaIndex(memory, META_TX_HEAD));
  const txTail = Atomics.load(memory.bytes, metaIndex(memory, META_TX_TAIL));
  let lsr = 0;
  if (queueLength(rxHead, rxTail) > 0) {
    lsr |= LSR_DR;
  }
  if (!queueIsFull(txHead, txTail)) {
    lsr |= LSR_THRE;
  }
  if (txHead === txTail) {
    lsr |= LSR_TEMT;
  }
  return lsr;
};

/**
 * Guest load of UART register `registerIndex` (0..7). RBR pops RX; LSR is derived from queues.
 */
const loadUartRegister = (memory: Memory, registerIndex: number): number => {
  if (registerIndex === 0) {
    return popReceive(memory);
  }
  if (registerIndex === 5) {
    return readLineStatus(memory);
  }
  return memory.bytes[memory.uartRegistersHostIndex + registerIndex] ?? 0;
};

/**
 * Guest store to UART register `registerIndex` (0..7). THR pushes TX (dropped if full);
 * LSR writes are ignored; other registers update the shadow at a host index.
 */
const storeUartRegister = (memory: Memory, registerIndex: number, value: number): void => {
  if (registerIndex === 0) {
    pushTransmit(memory, value);
    return;
  }
  if (registerIndex === 5) {
    return;
  }
  memory.bytes[memory.uartRegistersHostIndex + registerIndex] = value & 0xff;
};

export {
  META_BYTE_COUNT,
  UART_QUEUE_CAPACITY,
  UART_REGISTER_WINDOW,
  UART_TX_WAKE_HOST_SIZE,
  loadUartRegister,
  popUartTransmit,
  pushUartReceive,
  storeUartRegister,
  uartAddressToRegisterIndex,
  waitUartTransmit,
};
