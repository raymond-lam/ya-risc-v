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

import { andBytes, compareUnsignedBytes, isZeroBytes, orBytes, xorBytes } from '#utils/bytes';
import {
  PRIVILEGE_MACHINE,
  PRIVILEGE_SUPERVISOR,
  advanceProgramCounter,
  isControlAndStatusRegisterAccessAllowed,
  readGeneralPurposeRegister,
  readPrivilegeMode,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#emulator/cpu/registers';
import {
  CAUSE_BREAKPOINT,
  CAUSE_ILLEGAL_INSTRUCTION,
  ecallCauseForPrivilege,
  enterTrap,
  instructionWordTrapValue,
  returnFromMachineTrap,
  returnFromSupervisorTrap,
} from '#emulator/cpu/trap';
import type { Registers } from '#emulator/cpu/types';
import type { Memory } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';

type CsrRegisterArgs = {
  destinationRegister: number;
  sourceRegister1: number;
  controlAndStatusRegister: number;
  instructionWord: number;
};

type CsrImmediateArgs = {
  destinationRegister: number;
  immediate: ReadonlyUint8Array;
  controlAndStatusRegister: number;
  instructionWord: number;
};

const ALL_ONES_BYTES = new Uint8Array(8).fill(0xff) as ReadonlyUint8Array;

const trapIllegalCsrAccess = (registers: Registers, instructionWord: number): void => {
  enterTrap(registers, CAUSE_ILLEGAL_INSTRUCTION, instructionWordTrapValue(instructionWord));
};

/** ecall: environment call; cause depends on the current privilege mode. */
const ecall = (registers: Registers, _memory: Memory): void => {
  enterTrap(registers, ecallCauseForPrivilege(registers));
};

/** ebreak: breakpoint (synchronous trap, cause 3). */
const ebreak = (registers: Registers, _memory: Memory): void => {
  enterTrap(registers, CAUSE_BREAKPOINT);
};

/** mret: return from M-mode trap handler (illegal outside M-mode). */
const mret = (registers: Registers, _memory: Memory): void => {
  if (compareUnsignedBytes(readPrivilegeMode(registers), PRIVILEGE_MACHINE) !== 0) {
    enterTrap(registers, CAUSE_ILLEGAL_INSTRUCTION, instructionWordTrapValue(0x30200073));
    return;
  }
  returnFromMachineTrap(registers);
};

/** sret: return from S-mode trap handler (illegal in U-mode). */
const sret = (registers: Registers, _memory: Memory): void => {
  if (compareUnsignedBytes(readPrivilegeMode(registers), PRIVILEGE_SUPERVISOR) < 0) {
    enterTrap(registers, CAUSE_ILLEGAL_INSTRUCTION, instructionWordTrapValue(0x10200073));
    return;
  }
  returnFromSupervisorTrap(registers);
};

/** csrrw: rd = csr; csr = rs1. */
const csrrw = (registers: Registers, _memory: Memory, args: CsrRegisterArgs): void => {
  if (!isControlAndStatusRegisterAccessAllowed(registers, args.controlAndStatusRegister, true)) {
    trapIllegalCsrAccess(registers, args.instructionWord);
    return;
  }
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  writeControlAndStatusRegister(
    registers,
    args.controlAndStatusRegister,
    readGeneralPurposeRegister(registers, args.sourceRegister1)
  );
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrs: rd = csr; if rs1 ≠ x0, csr |= rs1. */
const csrrs = (registers: Registers, _memory: Memory, args: CsrRegisterArgs): void => {
  const writes = args.sourceRegister1 !== 0;
  if (!isControlAndStatusRegisterAccessAllowed(registers, args.controlAndStatusRegister, writes)) {
    trapIllegalCsrAccess(registers, args.instructionWord);
    return;
  }
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  if (writes) {
    writeControlAndStatusRegister(
      registers,
      args.controlAndStatusRegister,
      orBytes(
        new Uint8Array(8),
        previous,
        readGeneralPurposeRegister(registers, args.sourceRegister1)
      )
    );
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrc: rd = csr; if rs1 ≠ x0, csr &= ~rs1. */
const csrrc = (registers: Registers, _memory: Memory, args: CsrRegisterArgs): void => {
  const writes = args.sourceRegister1 !== 0;
  if (!isControlAndStatusRegisterAccessAllowed(registers, args.controlAndStatusRegister, writes)) {
    trapIllegalCsrAccess(registers, args.instructionWord);
    return;
  }
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  if (writes) {
    writeControlAndStatusRegister(
      registers,
      args.controlAndStatusRegister,
      andBytes(
        new Uint8Array(8),
        previous,
        xorBytes(
          new Uint8Array(8),
          readGeneralPurposeRegister(registers, args.sourceRegister1),
          ALL_ONES_BYTES
        )
      )
    );
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrwi: rd = csr; csr = zero-extended uimm. */
const csrrwi = (registers: Registers, _memory: Memory, args: CsrImmediateArgs): void => {
  if (!isControlAndStatusRegisterAccessAllowed(registers, args.controlAndStatusRegister, true)) {
    trapIllegalCsrAccess(registers, args.instructionWord);
    return;
  }
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  writeControlAndStatusRegister(registers, args.controlAndStatusRegister, args.immediate);
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrsi: rd = csr; if uimm ≠ 0, csr |= uimm. */
const csrrsi = (registers: Registers, _memory: Memory, args: CsrImmediateArgs): void => {
  const writes = !isZeroBytes(args.immediate);
  if (!isControlAndStatusRegisterAccessAllowed(registers, args.controlAndStatusRegister, writes)) {
    trapIllegalCsrAccess(registers, args.instructionWord);
    return;
  }
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  if (writes) {
    writeControlAndStatusRegister(
      registers,
      args.controlAndStatusRegister,
      orBytes(new Uint8Array(8), previous, args.immediate)
    );
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrci: rd = csr; if uimm ≠ 0, csr &= ~uimm. */
const csrrci = (registers: Registers, _memory: Memory, args: CsrImmediateArgs): void => {
  const writes = !isZeroBytes(args.immediate);
  if (!isControlAndStatusRegisterAccessAllowed(registers, args.controlAndStatusRegister, writes)) {
    trapIllegalCsrAccess(registers, args.instructionWord);
    return;
  }
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  if (writes) {
    writeControlAndStatusRegister(
      registers,
      args.controlAndStatusRegister,
      andBytes(
        new Uint8Array(8),
        previous,
        xorBytes(new Uint8Array(8), args.immediate, ALL_ONES_BYTES)
      )
    );
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

export { ecall, ebreak, mret, sret, csrrw, csrrs, csrrc, csrrwi, csrrsi, csrrci };
export type { CsrRegisterArgs, CsrImmediateArgs };
