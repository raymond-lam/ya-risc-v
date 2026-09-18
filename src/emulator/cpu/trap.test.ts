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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CAUSE_BREAKPOINT,
  CAUSE_ECALL_FROM_M,
  CAUSE_ECALL_FROM_U,
  CAUSE_ILLEGAL_INSTRUCTION,
  MCAUSE,
  MEDELEG,
  MEPC,
  MSTATUS,
  MTVAL,
  MTVEC,
  SCAUSE,
  SEPC,
  STVEC,
  enterTrap,
  instructionWordTrapValue,
  returnFromMachineTrap,
  returnFromSupervisorTrap,
} from '#emulator/cpu/trap';
import {
  PRIVILEGE_MACHINE,
  PRIVILEGE_SUPERVISOR,
  PRIVILEGE_USER,
  createRegisters,
  readControlAndStatusRegister,
  readPrivilegeMode,
  readProgramCounter,
  setPrivilegeMode,
  setProgramCounter,
  writeControlAndStatusRegister,
} from '#emulator/cpu/registers';
import { bytesToNumber, signedNumberToBytes, unsignedNumberToBytes } from '#utils/bytes';

describe('trap', () => {
  it('enterTrap saves mepc/mcause/mtval, updates mstatus, and jumps to mtvec', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x100, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2001, 32)
    );
    // MIE set so MPIE should become 1 after entry.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x08, 32)
    );

    enterTrap(registers, CAUSE_ECALL_FROM_M);

    assert.deepEqual(
      readControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x100, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ECALL_FROM_M, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MTVAL),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    // MPIE set, MIE clear, MPP = M → 0x1880.
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x1880, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_MACHINE);
    // Direct mode: low 2 bits of mtvec cleared.
    assert.deepEqual(
      readProgramCounter(registers),
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
  });

  it('enterTrap records MPP from the prior privilege mode', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x400, 32)
    );

    enterTrap(registers, CAUSE_BREAKPOINT);

    // MPIE clear, MIE clear, MPP = S → 0x0800.
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x0800, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_MACHINE);
  });

  it('enterTrap clears MPIE when MIE was clear', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x400, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );

    enterTrap(registers, CAUSE_BREAKPOINT);

    // MPIE clear, MIE clear, MPP = M → 0x1800.
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x1800, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_BREAKPOINT, 32)
    );
  });

  it('enterTrap records a zero-extended instruction word in mtval', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x800, 32)
    );
    const word = 0xdead_beef;

    enterTrap(registers, CAUSE_ILLEGAL_INSTRUCTION, instructionWordTrapValue(word));

    assert.deepEqual(
      readControlAndStatusRegister(registers, MTVAL),
      unsignedNumberToBytes(new Uint8Array(8), word)
    );
    assert.equal(bytesToNumber(readControlAndStatusRegister(registers, MTVAL)), word);
  });

  it('enterTrap delegates to S when medeleg allows and privilege is below M', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_USER);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x50, 32));
    writeControlAndStatusRegister(
      registers,
      MEDELEG,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_ECALL_FROM_U, 32)
    );
    writeControlAndStatusRegister(
      registers,
      STVEC,
      signedNumberToBytes(new Uint8Array(8), 0x3000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x02, 32)
    );

    enterTrap(registers, CAUSE_ECALL_FROM_U);

    assert.deepEqual(
      readControlAndStatusRegister(registers, SEPC),
      signedNumberToBytes(new Uint8Array(8), 0x50, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, SCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ECALL_FROM_U, 32)
    );
    // SPIE set, SIE clear, SPP = U → 0x20.
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x20, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_SUPERVISOR);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x3000);
  });

  it('returnFromMachineTrap restores MIE from MPIE, privilege from MPP, and sets MPP to U', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MEPC,
      signedNumberToBytes(new Uint8Array(8), 0x120, 32)
    );
    // MPIE set, MIE clear, MPP = S.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x0880, 32)
    );

    returnFromMachineTrap(registers);

    // MIE set, MPIE set, MPP = U → 0x0088.
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x0088, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_SUPERVISOR);
    assert.deepEqual(
      readProgramCounter(registers),
      signedNumberToBytes(new Uint8Array(8), 0x120, 32)
    );
  });

  it('returnFromMachineTrap leaves MIE clear when MPIE was clear', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MEPC,
      signedNumberToBytes(new Uint8Array(8), 0x40, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );

    returnFromMachineTrap(registers);

    // MIE clear, MPIE set, MPP = U → 0x0080.
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x0080, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_USER);
  });

  it('returnFromSupervisorTrap restores SIE from SPIE and privilege from SPP', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      SEPC,
      signedNumberToBytes(new Uint8Array(8), 0x60, 32)
    );
    // SPIE set, SIE clear, SPP = U.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x20, 32)
    );

    returnFromSupervisorTrap(registers);

    // SIE set, SPIE set, SPP = U → 0x22.
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x22, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_USER);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x60);
  });
});
