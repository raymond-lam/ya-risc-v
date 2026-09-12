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
import testMemory from '#test/guest-memory';
import {
  csrrc,
  csrrci,
  csrrs,
  csrrsi,
  csrrw,
  csrrwi,
  ebreak,
  ecall,
  mret,
} from '#cpu/instructions/system';
import {
  createRegisters,
  readControlAndStatusRegister,
  readGeneralPurposeRegister,
  readProgramCounter,
  setProgramCounter,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#cpu/registers';
import {
  CAUSE_BREAKPOINT,
  CAUSE_ECALL_FROM_M,
  CAUSE_ILLEGAL_INSTRUCTION,
  MCAUSE,
  MEPC,
  MSTATUS,
  MTVAL,
  MTVEC,
} from '#cpu/trap';
import { bytesToNumber, signedNumberToBytes } from '#utils/bytes';

const MHARTID = 0xf14;
/** Unimplemented CSR address used in illegal-access tests. */
const UNIMPLEMENTED_CSR = 0x400;

describe('system', () => {
  it('ecall traps to mtvec with cause 11 and does not advance pc past the ecall', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x08, 32)
    );

    ecall(registers, guest);

    assert.deepEqual(
      readControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x40, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ECALL_FROM_M, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
    // MPIE set, MIE clear, MPP = M → 0x1880.
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x1880, 32)
    );
  });

  it('ebreak traps to mtvec with cause 3', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );

    ebreak(registers, guest);

    assert.deepEqual(
      readControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_BREAKPOINT, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
  });

  it('mret returns to mepc and restores MIE from MPIE', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    writeControlAndStatusRegister(
      registers,
      MEPC,
      signedNumberToBytes(new Uint8Array(8), 0x44, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );

    mret(registers, guest);

    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x44);
    // MIE set, MPIE set, MPP = M → 0x1888.
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x1888, 32)
    );
  });

  it('csrrw swaps the CSR into rd and advances pc', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x11, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x22, 32));
    csrrw(registers, testMemory(256n), {
      destinationRegister: 1,
      sourceRegister1: 2,
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0x11, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x22, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('csrrw with rd = rs1 uses the old rs1 as the CSR write', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x11, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0x22, 32));
    csrrw(registers, testMemory(256n), {
      destinationRegister: 1,
      sourceRegister1: 1,
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0x11, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x22, 32)
    );
  });

  it('csrrw with rd = x0 still updates the CSR', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0x22, 32));
    csrrw(registers, testMemory(256n), {
      destinationRegister: 0,
      sourceRegister1: 1,
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 0)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x22, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('csrrs sets bits and csrrc clears bits', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0b1100, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0b1010, 32));

    csrrs(registers, testMemory(256n), {
      destinationRegister: 2,
      sourceRegister1: 1,
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 0b1100, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0b1110, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);

    csrrc(registers, testMemory(256n), {
      destinationRegister: 3,
      sourceRegister1: 1,
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 0b1110, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0b0100, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 8);
  });

  it('csrrs and csrrc with rs1 = x0 do not write the CSR', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );

    csrrs(registers, testMemory(256n), {
      destinationRegister: 1,
      sourceRegister1: 0,
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );

    csrrc(registers, testMemory(256n), {
      destinationRegister: 2,
      sourceRegister1: 0,
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );
  });

  it('csrrwi, csrrsi, and csrrci use a zero-extended immediate', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0b1100, 32)
    );

    csrrwi(registers, testMemory(256n), {
      destinationRegister: 1,
      immediate: signedNumberToBytes(new Uint8Array(8), 0b1010, 32),
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0b1100, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0b1010, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);

    csrrsi(registers, testMemory(256n), {
      destinationRegister: 2,
      immediate: signedNumberToBytes(new Uint8Array(8), 0b0101, 32),
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 0b1010, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0b1111, 32)
    );

    csrrci(registers, testMemory(256n), {
      destinationRegister: 3,
      immediate: signedNumberToBytes(new Uint8Array(8), 0b0011, 32),
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 0b1111, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0b1100, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 12);
  });

  it('csrrsi and csrrci with a zero immediate do not write the CSR', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );

    csrrsi(registers, testMemory(256n), {
      destinationRegister: 1,
      immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );

    csrrci(registers, testMemory(256n), {
      destinationRegister: 2,
      immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      controlAndStatusRegister: MSTATUS,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );
    assert.deepEqual(
      readControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );
  });

  it('csrrw to an identity CSR raises illegal-instruction', () => {
    const registers = createRegisters();
    const instructionWord = 0xf14011f3;
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 99, 32));
    csrrw(registers, testMemory(256n), {
      destinationRegister: 2,
      sourceRegister1: 1,
      controlAndStatusRegister: MHARTID,
      instructionWord,
    });
    assert.deepEqual(
      readControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(bytesToNumber(readControlAndStatusRegister(registers, MTVAL)), instructionWord);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
    assert.deepEqual(
      [...readControlAndStatusRegister(registers, MHARTID)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 2)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
  });

  it('csrrs with rs1 = x0 may read an identity CSR', () => {
    const registers = createRegisters();
    csrrs(registers, testMemory(256n), {
      destinationRegister: 1,
      sourceRegister1: 0,
      controlAndStatusRegister: MHARTID,
      instructionWord: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('access to an unimplemented CSR raises illegal-instruction', () => {
    const registers = createRegisters();
    const instructionWord = 0x400020f3;
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x20, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x3000, 32)
    );
    csrrs(registers, testMemory(256n), {
      destinationRegister: 1,
      sourceRegister1: 0,
      controlAndStatusRegister: UNIMPLEMENTED_CSR,
      instructionWord,
    });
    assert.deepEqual(
      readControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(bytesToNumber(readControlAndStatusRegister(registers, MTVAL)), instructionWord);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x3000);
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 1)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
  });
});
