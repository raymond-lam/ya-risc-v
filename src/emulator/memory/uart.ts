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

import { bytesToBigInt, bytesToInt32Array } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';
import { WAKE_HOST_SIZE, publishWakeLevel, waitWake } from '#emulator/memory/atomics';
import { PLIC_SOURCE_UART, setPlicSourcePending } from '#emulator/memory/plic';
import type { Memory } from '#emulator/memory/types';

/** Guest-visible 16550 register window size (RBR/THR … SCR). */
const UART_REGISTER_WINDOW = 8;

/**
 * Bytes of ring storage per direction. One slot is reserved so head===tail means empty
 * and (tail+1)%CAP===head means full (classic circular buffer).
 */
const UART_QUEUE_CAPACITY = 16;

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

/**
 * Interrupt Enable Register (IER) — guest writes which UART conditions may
 * assert the device IRQ (PLIC source 10 here).
 */
/** Enable Received Data Available Interrupt (ERBFI): IRQ when LSR.DR is set. */
const IER_ERBFI = 0x01;
/**
 * Enable Transmitter Holding Register Empty Interrupt (ETBEI). Asserts when
 * LSR.THRE is set (room for one more TX byte), via a sticky THRE IRQ bit that
 * clears on IIR read or THR write (16550).
 */
const IER_ETBEI = 0x02;

/**
 * Interrupt Identification Register (IIR) — guest-readable only (writes are
 * ignored). Encodes which UART IRQ is pending, or “none”. Reading IIR when the
 * identity is THRE clears the sticky THRE IRQ bit.
 */
/** No interrupt pending (bit 0 set). */
const IIR_NO_INTERRUPT = 0x01;
/**
 * Transmitter Holding Register (THR) empty: TX-empty IRQ (after RX if both).
 */
const IIR_THRE = 0x02;
/** Received Data Available (RDA): RX-ready IRQ. */
const IIR_RDA = 0x04;

/**
 * Line Control Register (LCR) — framing/baud setup. Bit 7 (DLAB) remaps the
 * first two register ports to the baud divisor latch instead of RBR/THR/IER.
 */
/** Divisor Latch Access Bit (DLAB). */
const LCR_DLAB = 0x80;

/** Byte offsets into queue meta: rxHead, rxTail, txHead, txTail. */
const META_RX_HEAD = 0;
const META_RX_TAIL = 1;
const META_TX_HEAD = 2;
const META_TX_TAIL = 3;
/** Host bytes reserved for UART queue head/tail indices. */
const META_BYTE_COUNT = 4;

/**
 * Host slot for the sticky THRE IRQ bit (IIR is derived; this byte is not guest
 * IIR storage). 1 = THRE interrupt pending until IIR read or THR write.
 */
const THRE_IRQ_STICKY_REGISTER = 2;

/** Host Int32: UART TX nonempty level (`0` empty / `1` nonempty) for the terminal pump. */
const UART_TX_WAKE_HOST_SIZE = WAKE_HOST_SIZE;

/** Publish whether the TX ring is nonempty; notify when that level changes. */
const publishUartTransmitLevel = (memory: Memory, nonempty: boolean): void => {
  publishWakeLevel({
    bytes: memory.bytes,
    index: memory.uartTxWakeHostIndex,
    level: nonempty ? 1 : 0,
  });
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

const registerHostIndex = (memory: Memory, registerIndex: number): number =>
  memory.uartRegistersHostIndex + registerIndex;

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
  for (;;) {
    if (uartTransmitPending(memory)) {
      return;
    }
    const fromLevel = Atomics.load(bytesToInt32Array(memory.bytes, memory.uartTxWakeHostIndex), 0);
    if (uartTransmitPending(memory)) {
      return;
    }
    await waitWake({
      bytes: memory.bytes,
      index: memory.uartTxWakeHostIndex,
      fromLevel,
    });
  }
};

const uartRegisterByte = (memory: Memory, registerIndex: number): number =>
  Atomics.load(memory.bytes, registerHostIndex(memory, registerIndex));

const storeUartRegisterByte = (memory: Memory, registerIndex: number, value: number): void => {
  Atomics.store(memory.bytes, registerHostIndex(memory, registerIndex), value & 0xff);
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

const threIrqSticky = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, registerHostIndex(memory, THRE_IRQ_STICKY_REGISTER)) !== 0;

const setThreIrqSticky = (memory: Memory, value: boolean): void => {
  Atomics.store(memory.bytes, registerHostIndex(memory, THRE_IRQ_STICKY_REGISTER), value ? 1 : 0);
};

/**
 * Arm the sticky THRE IRQ on a rising THRE edge while ETBEI is enabled.
 * Enabling ETBEI while THRE is already set also arms (16550).
 */
const armThreIrqOnRisingEdge = (memory: Memory, threBefore: boolean, threAfter: boolean): void => {
  if (threBefore || !threAfter) {
    return;
  }
  if ((uartRegisterByte(memory, 1) & IER_ETBEI) !== 0) {
    setThreIrqSticky(memory, true);
  }
};

/** Arm sticky THRE when ETBEI is enabled while LSR.THRE is already set. */
const armThreIrqIfEnabledAndReady = (memory: Memory): void => {
  const ier = uartRegisterByte(memory, 1);
  const lsr = readLineStatus(memory);
  if ((ier & IER_ETBEI) !== 0 && (lsr & LSR_THRE) !== 0) {
    setThreIrqSticky(memory, true);
  }
};

/**
 * Highest-priority pending UART interrupt id (IIR), or `IIR_NO_INTERRUPT`.
 * RX data outranks THRE. ETBEI uses sticky THRE (cleared by IIR read / THR write).
 */
const readInterruptIdentity = (memory: Memory): number => {
  const ier = uartRegisterByte(memory, 1);
  const lsr = readLineStatus(memory);
  if ((ier & IER_ERBFI) !== 0 && (lsr & LSR_DR) !== 0) {
    return IIR_RDA;
  }
  if ((ier & IER_ETBEI) !== 0 && threIrqSticky(memory) && (lsr & LSR_THRE) !== 0) {
    return IIR_THRE;
  }
  return IIR_NO_INTERRUPT;
};

/** Drive PLIC UART source 10 from IER ∧ (RX ready / sticky THRE). */
const refreshUartIrq = (memory: Memory): void => {
  setPlicSourcePending(
    memory,
    PLIC_SOURCE_UART,
    readInterruptIdentity(memory) !== IIR_NO_INTERRUPT
  );
};

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
  refreshUartIrq(memory);
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
  const threBefore = !queueIsFull(head, tail);
  const value = memory.bytes[memory.uartTxDataHostIndex + head] ?? 0;
  const nextHead = (head + 1) % UART_QUEUE_CAPACITY;
  Atomics.store(memory.bytes, metaIndex(memory, META_TX_HEAD), nextHead);
  publishUartTransmitLevel(memory, nextHead !== tail);
  const threAfter = !queueIsFull(nextHead, tail);
  armThreIrqOnRisingEdge(memory, threBefore, threAfter);
  refreshUartIrq(memory);
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
  memory.bytes[memory.uartTxDataHostIndex + tail] = value & 0xff;
  Atomics.store(memory.bytes, metaIndex(memory, META_TX_TAIL), (tail + 1) % UART_QUEUE_CAPACITY);
  publishUartTransmitLevel(memory, true);
  return true;
};

/**
 * Guest load of UART register `registerIndex` (0..7). RBR pops RX; IIR/LSR are derived;
 * with LCR.DLAB set, offsets 0/1 are divisor latches. Reading IIR clears sticky THRE.
 */
const loadUartRegister = (memory: Memory, registerIndex: number): number => {
  const dlab = (uartRegisterByte(memory, 3) & LCR_DLAB) !== 0;
  if (registerIndex === 0 && !dlab) {
    const value = popReceive(memory);
    refreshUartIrq(memory);
    return value;
  }
  if (registerIndex === 2) {
    const identity = readInterruptIdentity(memory);
    if (identity === IIR_THRE) {
      setThreIrqSticky(memory, false);
      refreshUartIrq(memory);
    }
    return identity;
  }
  if (registerIndex === 5) {
    return readLineStatus(memory);
  }
  return uartRegisterByte(memory, registerIndex);
};

/**
 * Guest store to UART register `registerIndex` (0..7). THR pushes TX (dropped if full)
 * and clears sticky THRE; IER refreshes PLIC source 10; IIR/FCR and LSR writes are ignored;
 * with LCR.DLAB set, offsets 0/1 are divisor latches.
 */
const storeUartRegister = (memory: Memory, registerIndex: number, value: number): void => {
  const byte = value & 0xff;
  const dlab = (uartRegisterByte(memory, 3) & LCR_DLAB) !== 0;
  if (registerIndex === 0 && !dlab) {
    setThreIrqSticky(memory, false);
    pushTransmit(memory, byte);
    // THRE may still be set (queue not full); do not re-arm until THRE falls then rises.
    refreshUartIrq(memory);
    return;
  }
  if (registerIndex === 2 || registerIndex === 5) {
    return;
  }
  storeUartRegisterByte(memory, registerIndex, byte);
  if (registerIndex === 1 && !dlab) {
    armThreIrqIfEnabledAndReady(memory);
    refreshUartIrq(memory);
  }
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
