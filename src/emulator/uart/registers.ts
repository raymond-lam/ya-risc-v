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
 * 16550 register semantics — RBR/THR/IER/IIR/LSR side effects and PLIC source 10.
 */

import type { Memory } from '#emulator/memory';
import { PLIC_SOURCE_UART, setPlicSourcePending } from '#emulator/plic';
import {
  LSR_DR,
  LSR_THRE,
  dequeueTransmit,
  enqueueReceive,
  popReceive,
  pushTransmit,
  readLineStatus,
} from '#emulator/uart/queues';
import {
  THRE_IRQ_STICKY_REGISTER,
  registerHostIndex,
  storeUartRegisterByte,
  uartRegisterByte,
} from '#emulator/uart/region';

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
  if (!enqueueReceive(memory, value)) {
    return false;
  }
  refreshUartIrq(memory);
  return true;
};

/**
 * Host: dequeue a transmitted byte. Returns `null` if the TX ring is empty.
 */
const popUartTransmit = (memory: Memory): number | null => {
  const dequeued = dequeueTransmit(memory);
  if (dequeued === null) {
    return null;
  }
  armThreIrqOnRisingEdge(memory, dequeued.threBefore, dequeued.threAfter);
  refreshUartIrq(memory);
  return dequeued.value;
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

export { loadUartRegister, popUartTransmit, pushUartReceive, storeUartRegister };
