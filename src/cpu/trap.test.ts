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
  CAUSE_ILLEGAL_INSTRUCTION,
  MCAUSE,
  MEPC,
  MSTATUS,
  MTVAL,
  MTVEC,
  enterTrap,
  instructionWordTrapValue,
  returnFromMachineTrap,
} from '#cpu/trap.js';
import {
  createRegisters,
  readControlAndStatusRegister,
  readProgramCounter,
  setProgramCounter,
  writeControlAndStatusRegister,
} from '#cpu/registers.js';
import { bytesToNumber, signedNumberToBytes, unsignedNumberToBytes } from '#utils/bytes.js';

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
    // Direct mode: low 2 bits of mtvec cleared.
    assert.deepEqual(
      readProgramCounter(registers),
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
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

  it('returnFromMachineTrap restores MIE from MPIE and jumps to mepc', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MEPC,
      signedNumberToBytes(new Uint8Array(8), 0x120, 32)
    );
    // MPIE set, MIE clear → after mret, MIE set and MPIE set.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );

    returnFromMachineTrap(registers);

    // MIE set, MPIE set, MPP = M → 0x1888.
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x1888, 32)
    );
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

    // MIE clear, MPIE set, MPP = M → 0x1880.
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x1880, 32)
    );
  });
});
