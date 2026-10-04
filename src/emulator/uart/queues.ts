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

/**
 * UART RX/TX rings and TX-wake wait — host slab queue mechanics without 16550 IRQ.
 */

import { bytesToInt32Array } from '#utils/bytes';
import { publishWakeLevel, waitWake } from '#emulator/wake';
import type { Memory } from '#emulator/memory';
import {
  META_RX_HEAD,
  META_RX_TAIL,
  META_TX_HEAD,
  META_TX_TAIL,
  UART_HOST_OFFSET,
  UART_QUEUE_CAPACITY,
  metaIndex,
  rxDataIndex,
  txDataIndex,
  uartByteIndex,
} from '#emulator/uart/region';

/**
 * Line Status Register (LSR) — read-only flags for RX/TX readiness (and errors
 * we do not model). Guest polls these, or enables matching IER bits for IRQs.
 */
/** Data Ready (DR): at least one RX byte is available. */
const LSR_DR = 0x01;
/**
 * Transmitter Holding Register Empty (THRE): room to accept another TX byte
 * (TX queue not full).
 */
const LSR_THRE = 0x20;
/** Transmitter Empty (TEMT): TX queue fully drained (nothing left to send). */
const LSR_TEMT = 0x40;

/** Publish whether the TX ring is nonempty; notify when that level changes. */
const publishUartTransmitLevel = (memory: Memory, nonempty: boolean): void => {
  publishWakeLevel({
    bytes: memory.bytes,
    index: uartByteIndex(memory, UART_HOST_OFFSET.txWake),
    level: nonempty ? 1 : 0,
  });
};

/** True when the TX ring has at least one byte to drain. */
const uartTransmitPending = (memory: Memory): boolean => {
  const head = Atomics.load(memory.bytes, metaIndex(memory, META_TX_HEAD));
  const tail = Atomics.load(memory.bytes, metaIndex(memory, META_TX_TAIL));
  return head !== tail;
};

/**
 * Wait until the UART TX ring has data. Double-checks around a snapshot of the
 * nonempty level word (same pattern as `wfi` / hart IRQ level).
 */
const waitUartTransmit = async (memory: Memory): Promise<void> => {
  const txWakeIndex = uartByteIndex(memory, UART_HOST_OFFSET.txWake);
  for (;;) {
    if (uartTransmitPending(memory)) {
      return;
    }
    const fromLevel = Atomics.load(bytesToInt32Array(memory.bytes, txWakeIndex), 0);
    if (uartTransmitPending(memory)) {
      return;
    }
    await waitWake({
      bytes: memory.bytes,
      index: txWakeIndex,
      fromLevel,
    });
  }
};

const queueLength = (head: number, tail: number): number =>
  (tail - head + UART_QUEUE_CAPACITY) % UART_QUEUE_CAPACITY;

const queueIsFull = (head: number, tail: number): boolean =>
  (tail + 1) % UART_QUEUE_CAPACITY === head;

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

/** Pop one RX byte (0 if empty). Does not refresh PLIC. */
const popReceive = (memory: Memory): number => {
  const head = Atomics.load(memory.bytes, metaIndex(memory, META_RX_HEAD));
  const tail = Atomics.load(memory.bytes, metaIndex(memory, META_RX_TAIL));
  if (head === tail) {
    return 0;
  }
  const value = memory.bytes[rxDataIndex(memory, head)] ?? 0;
  Atomics.store(memory.bytes, metaIndex(memory, META_RX_HEAD), (head + 1) % UART_QUEUE_CAPACITY);
  return value;
};

/** Push one TX byte. Returns false if full. Does not refresh PLIC. */
const pushTransmit = (memory: Memory, value: number): boolean => {
  const head = Atomics.load(memory.bytes, metaIndex(memory, META_TX_HEAD));
  const tail = Atomics.load(memory.bytes, metaIndex(memory, META_TX_TAIL));
  if (queueIsFull(head, tail)) {
    return false;
  }
  memory.bytes[txDataIndex(memory, tail)] = value & 0xff;
  Atomics.store(memory.bytes, metaIndex(memory, META_TX_TAIL), (tail + 1) % UART_QUEUE_CAPACITY);
  publishUartTransmitLevel(memory, true);
  return true;
};

/**
 * Enqueue a received byte without refreshing PLIC. Returns false if the RX ring
 * is full (byte dropped).
 */
const enqueueReceive = (memory: Memory, value: number): boolean => {
  const head = Atomics.load(memory.bytes, metaIndex(memory, META_RX_HEAD));
  const tail = Atomics.load(memory.bytes, metaIndex(memory, META_RX_TAIL));
  if (queueIsFull(head, tail)) {
    return false;
  }
  memory.bytes[rxDataIndex(memory, tail)] = value & 0xff;
  Atomics.store(memory.bytes, metaIndex(memory, META_RX_TAIL), (tail + 1) % UART_QUEUE_CAPACITY);
  return true;
};

/**
 * Dequeue a transmitted byte without refreshing PLIC. Returns `null` if empty.
 * Updates the TX-wake level and reports THRE before/after for sticky IRQ arming.
 */
const dequeueTransmit = (
  memory: Memory
): { value: number; threBefore: boolean; threAfter: boolean } | null => {
  const head = Atomics.load(memory.bytes, metaIndex(memory, META_TX_HEAD));
  const tail = Atomics.load(memory.bytes, metaIndex(memory, META_TX_TAIL));
  if (head === tail) {
    return null;
  }
  const threBefore = !queueIsFull(head, tail);
  const value = memory.bytes[txDataIndex(memory, head)] ?? 0;
  const nextHead = (head + 1) % UART_QUEUE_CAPACITY;
  Atomics.store(memory.bytes, metaIndex(memory, META_TX_HEAD), nextHead);
  publishUartTransmitLevel(memory, nextHead !== tail);
  const threAfter = !queueIsFull(nextHead, tail);
  return { value, threBefore, threAfter };
};

export {
  LSR_DR,
  LSR_THRE,
  dequeueTransmit,
  enqueueReceive,
  popReceive,
  pushTransmit,
  readLineStatus,
  waitUartTransmit,
};
