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
import { addi, slli, slti, sltiu, srai, srli, xori } from '#emulator/cpu/instructions/op-imm';
import {
  createRegisters,
  readGeneralPurposeRegister,
  readProgramCounter,
  writeGeneralPurposeRegister,
  FOUR_BYTES,
} from '#emulator/cpu/registers';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

describe('op-imm', () => {
  it('addi writes rs1 + imm and advances pc', () => {
    const registers = createRegisters();
    addi(
      registers,
      testMemory(256n),
      {
        destinationRegister: 1,
        sourceRegister1: 0,
        immediate: signedNumberToBytes(new Uint8Array(8), 10, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 10, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('slti and sltiu compare signed vs unsigned', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), -1, 32));

    slti(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        immediate: signedNumberToBytes(new Uint8Array(8), 1, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );

    sltiu(
      registers,
      testMemory(256n),
      {
        destinationRegister: 3,
        sourceRegister1: 1,
        immediate: signedNumberToBytes(new Uint8Array(8), 1, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
  });

  it('xori bitwise-xors the immediate', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0x0f, 32));
    xori(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        immediate: signedNumberToBytes(new Uint8Array(8), 0xff, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 0xf0, 32)
    );
  });

  it('slli/srli/srai honor shamt 32-63 (6-bit shifts)', () => {
    const registers = createRegisters();

    // slli x1 = 1 << 63
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 1, 32));
    slli(
      registers,
      testMemory(256n),
      { destinationRegister: 2, sourceRegister1: 1, shiftAmount: 63 },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000_0000_0000n)
    );

    // srli x3 = 0x8000...0000 >> 63 = 1
    writeGeneralPurposeRegister(
      registers,
      1,
      unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000_0000_0000n)
    );
    srli(
      registers,
      testMemory(256n),
      { destinationRegister: 3, sourceRegister1: 1, shiftAmount: 63 },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );

    // srai x4 = 0x0000_0001_0000_0000 >> 63 = 0 (and 5-bit masking would give 1 << ... != 0 path)
    writeGeneralPurposeRegister(
      registers,
      1,
      unsignedBigIntToBytes(new Uint8Array(8), 0x0000_0001_0000_0000n)
    );
    srai(
      registers,
      testMemory(256n),
      { destinationRegister: 4, sourceRegister1: 1, shiftAmount: 63 },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 4), new Uint8Array(8));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 12);
  });
});
