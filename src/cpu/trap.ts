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

import { signedNumberToBytes, unsignedNumberToBytes } from '#utils/bytes.js';
import {
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  readProgramCounter,
  setProgramCounter,
} from '#cpu/registers.js';
import type { Registers } from '#cpu/types.js';

/** Machine-mode CSRs used by trap entry and `mret`. */
const MSTATUS = 0x300;
const MTVEC = 0x305;
const MEPC = 0x341;
const MCAUSE = 0x342;
const MTVAL = 0x343;

/** Synchronous exception codes (mcause with interrupt bit clear). */
const CAUSE_ILLEGAL_INSTRUCTION = 2;
const CAUSE_BREAKPOINT = 3;
const CAUSE_ECALL_FROM_M = 11;

/**
 * mstatus bit layouts in the little-endian CSR bytes (RV64):
 *   MIE  = bit 3  → bytes[0] & 0x08
 *   MPIE = bit 7  → bytes[0] & 0x80
 *   MPP  = bits 12:11 → bytes[1] & 0x18
 */
const MSTATUS_BYTE0_MIE = 0x08;
const MSTATUS_BYTE0_MPIE = 0x80;
const MSTATUS_BYTE1_MPP_MASK = 0x18;
/** MPP = 11 (machine) in bits 12:11 → 0b11 << 3 in byte 1. */
const MSTATUS_BYTE1_MPP_MACHINE = 0x18;

/** On trap entry: MPIE ← MIE, MIE ← 0, MPP ← M. */
const applyTrapEntryToMstatus = (registers: Registers): Uint8Array => {
  // Snapshot first — the CSR slot is live and must not be mutated mid-update.
  const mstatus = snapshotControlAndStatusRegister(registers, MSTATUS);
  // MIE ("machine interrupt enable") — were global M-mode interrupts on before this trap?
  const mieSet = (mstatus[0]! & MSTATUS_BYTE0_MIE) !== 0;
  // MPIE ← MIE: save that on/off state so mret can restore it later.
  if (mieSet) {
    mstatus[0]! |= MSTATUS_BYTE0_MPIE;
  } else {
    mstatus[0]! &= ~MSTATUS_BYTE0_MPIE;
  }
  // MIE ← 0: disable interrupts while the trap handler runs (avoid nested traps).
  mstatus[0]! &= ~MSTATUS_BYTE0_MIE;
  // MPP ← M: record that we were in machine mode when the trap occurred.
  mstatus[1] = (mstatus[1]! & ~MSTATUS_BYTE1_MPP_MASK) | MSTATUS_BYTE1_MPP_MACHINE;
  return writeControlAndStatusRegister(registers, MSTATUS, mstatus);
};

/** On mret: MIE ← MPIE, MPIE ← 1, MPP ← M (M-mode-only hart). */
const applyMachineReturnToMstatus = (registers: Registers): Uint8Array => {
  // Snapshot first — the CSR slot is live and must not be mutated mid-update.
  const mstatus = snapshotControlAndStatusRegister(registers, MSTATUS);
  // MPIE ("machine previous interrupt enable") was set from MIE when the trap fired.
  const mpieSet = (mstatus[0]! & MSTATUS_BYTE0_MPIE) !== 0;
  // Restore MIE from that saved value so global interrupts are on/off as before the trap.
  if (mpieSet) {
    mstatus[0]! |= MSTATUS_BYTE0_MIE;
  } else {
    mstatus[0]! &= ~MSTATUS_BYTE0_MIE;
  }
  // mret sets MPIE ← 1 (we return to M-mode, so "prior enable" is now considered set).
  mstatus[0]! |= MSTATUS_BYTE0_MPIE;
  // MPP ("machine previous privilege") ← M; this hart only runs in machine mode.
  mstatus[1] = (mstatus[1]! & ~MSTATUS_BYTE1_MPP_MASK) | MSTATUS_BYTE1_MPP_MACHINE;
  return writeControlAndStatusRegister(registers, MSTATUS, mstatus);
};

/**
 * Enter an M-mode synchronous trap: save PC/cause/tval, update mstatus, jump to mtvec.
 * Direct mode only — MODE bits in mtvec are cleared (PC = mtvec with bits 1:0 = 0).
 */
const enterTrap = (
  registers: Registers,
  cause: number,
  trapValue: Uint8Array = signedNumberToBytes(new Uint8Array(8), 0, 32)
): void => {
  // mepc ← PC: save where we were so mret can resume (usually the faulting instruction).
  writeControlAndStatusRegister(registers, MEPC, readProgramCounter(registers));
  // mcause ← why we trapped (e.g. illegal opcode = 2, ebreak = 3, ecall from M = 11).
  writeControlAndStatusRegister(
    registers,
    MCAUSE,
    signedNumberToBytes(new Uint8Array(8), cause, 32)
  );
  // mtval ← extra context (faulting instruction word, bad address, …); defaults to 0.
  writeControlAndStatusRegister(registers, MTVAL, trapValue);

  // mstatus: MPIE ← MIE, MIE ← 0, MPP ← M — disable interrupts and record we were in M-mode.
  applyTrapEntryToMstatus(registers);

  // mtvec holds the trap-handler address; direct mode ignores the low two MODE bits.
  const handler = snapshotControlAndStatusRegister(registers, MTVEC);
  handler[0]! &= ~0x03;
  // PC ← handler — transfer control to firmware/OS trap code (no +4 fall-through).
  setProgramCounter(registers, handler);
};

/** mret: restore interrupt-enable stack from mstatus, PC ← mepc. */
const returnFromMachineTrap = (registers: Registers): void => {
  // Undo trap-entry mstatus changes: MIE ← MPIE, MPIE ← 1, MPP ← M.
  applyMachineReturnToMstatus(registers);

  // PC ← mepc — jump back to the saved program counter and continue guest execution.
  setProgramCounter(registers, snapshotControlAndStatusRegister(registers, MEPC));
};

/** Zero-extend a 32-bit instruction encoding for mtval. */
const instructionWordTrapValue = (instructionWord: number): Uint8Array =>
  unsignedNumberToBytes(new Uint8Array(8), instructionWord);

export {
  MSTATUS,
  MTVEC,
  MEPC,
  MCAUSE,
  MTVAL,
  CAUSE_ILLEGAL_INSTRUCTION,
  CAUSE_BREAKPOINT,
  CAUSE_ECALL_FROM_M,
  enterTrap,
  returnFromMachineTrap,
  instructionWordTrapValue,
};
