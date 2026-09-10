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

import { bytesToBigInt } from '#utils/bytes.js';
import type { Memory, ReadonlyUint8Array } from '#types.js';

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

/** Int32 indices into the queue-meta view: rxHead, rxTail, txHead, txTail. */
const META_RX_HEAD = 0;
const META_RX_TAIL = 1;
const META_TX_HEAD = 2;
const META_TX_TAIL = 3;
const META_INT32_COUNT = 4;

type UartHostLayout = {
  /** Host index of the first UART register-shadow byte in `memory.bytes`. */
  registersHostIndex: number;
  /** Host index of the Int32 queue metadata (rx/tx head and tail). */
  metaHostIndex: number;
  /** Host index of the first RX ring byte. */
  rxDataHostIndex: number;
  /** Host index of the first TX ring byte. */
  txDataHostIndex: number;
  /** Total host bytes: RAM + registers + meta + both rings. */
  packedByteLength: number;
};

const align4 = (value: number): number => (value + 3) & ~3;

/**
 * Host packing after RAM (all fields are host indices into `memory.bytes`):
 *   [registers 8][pad to 4][rxHead rxTail txHead txTail][rx ring][tx ring]
 * Queue rings are not guest-mapped; only the 8-byte window is.
 */
const uartHostLayout = (ramSize: bigint): UartHostLayout => {
  const registersHostIndex = Number(ramSize);
  const metaHostIndex = align4(registersHostIndex + UART_REGISTER_WINDOW);
  const rxDataHostIndex = metaHostIndex + META_INT32_COUNT * 4;
  const txDataHostIndex = rxDataHostIndex + UART_QUEUE_CAPACITY;
  const packedByteLength = txDataHostIndex + UART_QUEUE_CAPACITY;
  return { registersHostIndex, metaHostIndex, rxDataHostIndex, txDataHostIndex, packedByteLength };
};

/** Total packed host buffer length for the given RAM size (RAM + UART shadow + queues). */
const uartPackedByteLength = (ramSize: bigint): number => uartHostLayout(ramSize).packedByteLength;

const uartOverlapsRam = ({
  ramBaseAddress,
  ramSize,
  uartBaseAddress,
}: {
  ramBaseAddress: ReadonlyUint8Array;
  ramSize: bigint;
  uartBaseAddress: ReadonlyUint8Array;
}): boolean => {
  if (ramSize === 0n) {
    return false;
  }
  const ramBase = bytesToBigInt(ramBaseAddress);
  const uartBase = bytesToBigInt(uartBaseAddress);
  const uartEnd = uartBase + BigInt(UART_REGISTER_WINDOW);
  return ramBase < uartEnd && uartBase < ramBase + ramSize;
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

const queueMeta = (memory: Memory): Int32Array => {
  const { metaHostIndex } = uartHostLayout(memory.ramSize);
  return new Int32Array(memory.bytes.buffer, metaHostIndex, META_INT32_COUNT);
};

const queueLength = (head: number, tail: number): number =>
  (tail - head + UART_QUEUE_CAPACITY) % UART_QUEUE_CAPACITY;

const queueIsFull = (head: number, tail: number): boolean =>
  (tail + 1) % UART_QUEUE_CAPACITY === head;

/**
 * Host/keyboard: enqueue a received byte. Returns false if the RX ring is full (byte dropped).
 */
const pushReceive = (memory: Memory, value: number): boolean => {
  const meta = queueMeta(memory);
  const head = Atomics.load(meta, META_RX_HEAD);
  const tail = Atomics.load(meta, META_RX_TAIL);
  if (queueIsFull(head, tail)) {
    return false;
  }
  const { rxDataHostIndex } = uartHostLayout(memory.ramSize);
  memory.bytes[rxDataHostIndex + tail] = value & 0xff;
  Atomics.store(meta, META_RX_TAIL, (tail + 1) % UART_QUEUE_CAPACITY);
  return true;
};

/**
 * Host: dequeue a transmitted byte. Returns `null` if the TX ring is empty.
 */
const popTransmit = (memory: Memory): number | null => {
  const meta = queueMeta(memory);
  const head = Atomics.load(meta, META_TX_HEAD);
  const tail = Atomics.load(meta, META_TX_TAIL);
  if (head === tail) {
    return null;
  }
  const { txDataHostIndex } = uartHostLayout(memory.ramSize);
  const value = memory.bytes[txDataHostIndex + head] ?? 0;
  Atomics.store(meta, META_TX_HEAD, (head + 1) % UART_QUEUE_CAPACITY);
  return value;
};

const popReceive = (memory: Memory): number => {
  const meta = queueMeta(memory);
  const head = Atomics.load(meta, META_RX_HEAD);
  const tail = Atomics.load(meta, META_RX_TAIL);
  if (head === tail) {
    return 0;
  }
  const { rxDataHostIndex } = uartHostLayout(memory.ramSize);
  const value = memory.bytes[rxDataHostIndex + head] ?? 0;
  Atomics.store(meta, META_RX_HEAD, (head + 1) % UART_QUEUE_CAPACITY);
  return value;
};

const pushTransmit = (memory: Memory, value: number): boolean => {
  const meta = queueMeta(memory);
  const head = Atomics.load(meta, META_TX_HEAD);
  const tail = Atomics.load(meta, META_TX_TAIL);
  if (queueIsFull(head, tail)) {
    return false;
  }
  const { txDataHostIndex } = uartHostLayout(memory.ramSize);
  memory.bytes[txDataHostIndex + tail] = value & 0xff;
  Atomics.store(meta, META_TX_TAIL, (tail + 1) % UART_QUEUE_CAPACITY);
  return true;
};

const readLineStatus = (memory: Memory): number => {
  const meta = queueMeta(memory);
  const rxHead = Atomics.load(meta, META_RX_HEAD);
  const rxTail = Atomics.load(meta, META_RX_TAIL);
  const txHead = Atomics.load(meta, META_TX_HEAD);
  const txTail = Atomics.load(meta, META_TX_TAIL);
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
  const { registersHostIndex } = uartHostLayout(memory.ramSize);
  return memory.bytes[registersHostIndex + registerIndex] ?? 0;
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
  const { registersHostIndex } = uartHostLayout(memory.ramSize);
  memory.bytes[registersHostIndex + registerIndex] = value & 0xff;
};

export {
  loadUartRegister,
  popTransmit,
  pushReceive,
  storeUartRegister,
  uartAddressToRegisterIndex,
  uartOverlapsRam,
  uartPackedByteLength,
};
