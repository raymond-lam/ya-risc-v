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

import {
  bytesToBigInt,
  compareUnsignedBytes,
  signedNumberToBytes,
  unsignedNumberToBytes,
} from '#utils/bytes';
import {
  MEDELEG,
  MSTATUS,
  MTVEC,
  MEPC,
  MCAUSE,
  MTVAL,
  SSTATUS,
  STVEC,
  SEPC,
  SCAUSE,
  STVAL,
  PRIVILEGE_USER,
  PRIVILEGE_SUPERVISOR,
  PRIVILEGE_MACHINE,
  MSTATUS_BYTE1_MPP_MASK,
  MSTATUS_BYTE1_MPP_USER,
  mppBitsFromPrivilegeMode,
  privilegeModeFromMppBits,
  readPrivilegeMode,
  setPrivilegeMode,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  readProgramCounter,
  setProgramCounter,
} from '#emulator/cpu/registers';
import type { Registers } from '#emulator/cpu/types';
import type { ReadonlyUint8Array } from '#emulator/memory';

/** Synchronous exception codes (mcause/scause with interrupt bit clear). */
const CAUSE_ILLEGAL_INSTRUCTION = 2;
const CAUSE_BREAKPOINT = 3;
const CAUSE_ECALL_FROM_U = 8;
const CAUSE_ECALL_FROM_S = 9;
const CAUSE_ECALL_FROM_M = 11;

/**
 * mstatus / sstatus bit layouts in the little-endian CSR bytes (RV64):
 *   SIE  = bit 1  → bytes[0] & 0x02
 *   MIE  = bit 3  → bytes[0] & 0x08
 *   SPIE = bit 5  → bytes[0] & 0x20
 *   MPIE = bit 7  → bytes[0] & 0x80
 *   SPP  = bit 8  → bytes[1] & 0x01
 *   MPP  = bits 12:11 → bytes[1] & 0x18
 */
const MSTATUS_BYTE0_SIE = 0x02; // S-mode interrupt enable
const MSTATUS_BYTE0_MIE = 0x08; // M-mode interrupt enable
const MSTATUS_BYTE0_SPIE = 0x20; // S previous interrupt enable (SIE saved on trap to S)
const MSTATUS_BYTE0_MPIE = 0x80; // M previous interrupt enable (MIE saved on trap to M)
const MSTATUS_BYTE1_SPP = 0x01; // S previous privilege (U/S; saved on trap to S)

const ecallCauseForPrivilege = (registers: Registers): number => {
  const mode = readPrivilegeMode(registers);
  if (compareUnsignedBytes(mode, PRIVILEGE_USER) === 0) {
    return CAUSE_ECALL_FROM_U;
  }
  if (compareUnsignedBytes(mode, PRIVILEGE_SUPERVISOR) === 0) {
    return CAUSE_ECALL_FROM_S;
  }
  return CAUSE_ECALL_FROM_M;
};

/** Delegate to S when not already in M and medeleg bit[cause] is set. */
const shouldDelegateToSupervisor = (registers: Registers, cause: number): boolean => {
  if (compareUnsignedBytes(readPrivilegeMode(registers), PRIVILEGE_MACHINE) === 0) {
    return false;
  }
  const medeleg = bytesToBigInt(snapshotControlAndStatusRegister(registers, MEDELEG));
  return (medeleg & (1n << BigInt(cause))) !== 0n;
};

/** On M-mode trap entry: MPIE ← MIE, MIE ← 0, MPP ← current privilege. */
const applyTrapEntryToMstatus = (registers: Registers): void => {
  const mstatus = snapshotControlAndStatusRegister(registers, MSTATUS);
  const mieSet = (mstatus[0]! & MSTATUS_BYTE0_MIE) !== 0;
  if (mieSet) {
    mstatus[0]! |= MSTATUS_BYTE0_MPIE;
  } else {
    mstatus[0]! &= ~MSTATUS_BYTE0_MPIE;
  }
  mstatus[0]! &= ~MSTATUS_BYTE0_MIE;
  mstatus[1] =
    (mstatus[1]! & ~MSTATUS_BYTE1_MPP_MASK) |
    mppBitsFromPrivilegeMode(readPrivilegeMode(registers));
  writeControlAndStatusRegister(registers, MSTATUS, mstatus);
};

/** On S-mode trap entry: SPIE ← SIE, SIE ← 0, SPP ← current (U or S). */
const applyTrapEntryToSstatus = (registers: Registers): void => {
  const mstatus = snapshotControlAndStatusRegister(registers, MSTATUS);
  const sieSet = (mstatus[0]! & MSTATUS_BYTE0_SIE) !== 0;
  if (sieSet) {
    mstatus[0]! |= MSTATUS_BYTE0_SPIE;
  } else {
    mstatus[0]! &= ~MSTATUS_BYTE0_SPIE;
  }
  mstatus[0]! &= ~MSTATUS_BYTE0_SIE;
  if (compareUnsignedBytes(readPrivilegeMode(registers), PRIVILEGE_SUPERVISOR) === 0) {
    mstatus[1]! |= MSTATUS_BYTE1_SPP;
  } else {
    mstatus[1]! &= ~MSTATUS_BYTE1_SPP;
  }
  writeControlAndStatusRegister(registers, MSTATUS, mstatus);
};

/** On mret: MIE ← MPIE, MPIE ← 1, privilege ← MPP, MPP ← U. */
const applyMachineReturnToMstatus = (registers: Registers): void => {
  const mstatus = snapshotControlAndStatusRegister(registers, MSTATUS);
  const mpieSet = (mstatus[0]! & MSTATUS_BYTE0_MPIE) !== 0;
  if (mpieSet) {
    mstatus[0]! |= MSTATUS_BYTE0_MIE;
  } else {
    mstatus[0]! &= ~MSTATUS_BYTE0_MIE;
  }
  mstatus[0]! |= MSTATUS_BYTE0_MPIE;
  const previous = privilegeModeFromMppBits(mstatus[1]! & MSTATUS_BYTE1_MPP_MASK);
  mstatus[1] = (mstatus[1]! & ~MSTATUS_BYTE1_MPP_MASK) | MSTATUS_BYTE1_MPP_USER;
  writeControlAndStatusRegister(registers, MSTATUS, mstatus);
  setPrivilegeMode(registers, previous);
};

/** On sret: SIE ← SPIE, SPIE ← 1, privilege ← SPP, SPP ← U. */
const applySupervisorReturnToSstatus = (registers: Registers): void => {
  const mstatus = snapshotControlAndStatusRegister(registers, MSTATUS);
  const spieSet = (mstatus[0]! & MSTATUS_BYTE0_SPIE) !== 0;
  if (spieSet) {
    mstatus[0]! |= MSTATUS_BYTE0_SIE;
  } else {
    mstatus[0]! &= ~MSTATUS_BYTE0_SIE;
  }
  mstatus[0]! |= MSTATUS_BYTE0_SPIE;
  const previous = (mstatus[1]! & MSTATUS_BYTE1_SPP) !== 0 ? PRIVILEGE_SUPERVISOR : PRIVILEGE_USER;
  mstatus[1]! &= ~MSTATUS_BYTE1_SPP;
  writeControlAndStatusRegister(registers, MSTATUS, mstatus);
  setPrivilegeMode(registers, previous);
};

const enterMachineTrap = (
  registers: Registers,
  cause: number,
  trapValue: ReadonlyUint8Array
): void => {
  writeControlAndStatusRegister(registers, MEPC, readProgramCounter(registers));
  writeControlAndStatusRegister(
    registers,
    MCAUSE,
    signedNumberToBytes(new Uint8Array(8), cause, 32)
  );
  writeControlAndStatusRegister(registers, MTVAL, trapValue);
  applyTrapEntryToMstatus(registers);
  setPrivilegeMode(registers, PRIVILEGE_MACHINE);
  const handler = snapshotControlAndStatusRegister(registers, MTVEC);
  handler[0]! &= ~0x03;
  setProgramCounter(registers, handler);
};

const enterSupervisorTrap = (
  registers: Registers,
  cause: number,
  trapValue: ReadonlyUint8Array
): void => {
  writeControlAndStatusRegister(registers, SEPC, readProgramCounter(registers));
  writeControlAndStatusRegister(
    registers,
    SCAUSE,
    signedNumberToBytes(new Uint8Array(8), cause, 32)
  );
  writeControlAndStatusRegister(registers, STVAL, trapValue);
  applyTrapEntryToSstatus(registers);
  setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
  const handler = snapshotControlAndStatusRegister(registers, STVEC);
  handler[0]! &= ~0x03;
  setProgramCounter(registers, handler);
};

/**
 * Enter a synchronous trap: save PC/cause/tval, update status, jump to xtvec.
 * Delegates to S when `medeleg` allows and the hart is not already in M.
 * Direct mode only — MODE bits in xtvec are cleared.
 */
const enterTrap = (
  registers: Registers,
  cause: number,
  trapValue: ReadonlyUint8Array = signedNumberToBytes(new Uint8Array(8), 0, 32)
): void => {
  if (shouldDelegateToSupervisor(registers, cause)) {
    enterSupervisorTrap(registers, cause, trapValue);
    return;
  }
  enterMachineTrap(registers, cause, trapValue);
};

/** mret: restore interrupt-enable / privilege stack from mstatus, PC ← mepc. */
const returnFromMachineTrap = (registers: Registers): void => {
  applyMachineReturnToMstatus(registers);
  setProgramCounter(registers, snapshotControlAndStatusRegister(registers, MEPC));
};

/** sret: restore interrupt-enable / privilege stack from sstatus, PC ← sepc. */
const returnFromSupervisorTrap = (registers: Registers): void => {
  applySupervisorReturnToSstatus(registers);
  setProgramCounter(registers, snapshotControlAndStatusRegister(registers, SEPC));
};

/** Zero-extend a 32-bit instruction encoding for mtval/stval. */
const instructionWordTrapValue = (instructionWord: number): ReadonlyUint8Array =>
  unsignedNumberToBytes(new Uint8Array(8), instructionWord);

export {
  MSTATUS,
  MEDELEG,
  MTVEC,
  MEPC,
  MCAUSE,
  MTVAL,
  SSTATUS,
  STVEC,
  SEPC,
  SCAUSE,
  STVAL,
  CAUSE_ILLEGAL_INSTRUCTION,
  CAUSE_BREAKPOINT,
  CAUSE_ECALL_FROM_U,
  CAUSE_ECALL_FROM_S,
  CAUSE_ECALL_FROM_M,
  enterTrap,
  returnFromMachineTrap,
  returnFromSupervisorTrap,
  ecallCauseForPrivilege,
  instructionWordTrapValue,
};
