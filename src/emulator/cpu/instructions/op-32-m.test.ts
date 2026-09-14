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
import { mulw, divw, remw, divuw, remuw } from '#emulator/cpu/instructions/op-32-m';
import {
  createRegisters,
  readGeneralPurposeRegister,
  readProgramCounter,
  writeGeneralPurposeRegister,
} from '#emulator/cpu/registers';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

describe('op-32-m', () => {
  it('mulw multiplies the low halves and sign-extends', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(
      registers,
      1,
      unsignedBigIntToBytes(new Uint8Array(8), 0x1_0000_0007n)
    );
    writeGeneralPurposeRegister(
      registers,
      2,
      unsignedBigIntToBytes(new Uint8Array(8), 0x2_0000_0006n)
    );
    mulw(registers, testMemory(256n), {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 42, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('divw and remw follow 32-bit divide-by-zero and overflow rules', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 20, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0, 32));
    divw(registers, testMemory(256n), {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), -1, 32)
    );
    remw(registers, testMemory(256n), {
      destinationRegister: 4,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 4),
      signedNumberToBytes(new Uint8Array(8), 20, 32)
    );

    writeGeneralPurposeRegister(
      registers,
      1,
      signedNumberToBytes(new Uint8Array(8), 0x80000000, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), -1, 32));
    divw(registers, testMemory(256n), {
      destinationRegister: 5,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 5),
      signedNumberToBytes(new Uint8Array(8), 0x80000000, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 12);
  });

  it('divuw and remuw treat the low halves as unsigned', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(
      registers,
      1,
      signedNumberToBytes(new Uint8Array(8), 0xfffffffe, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 2, 32));
    divuw(registers, testMemory(256n), {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 0x7fffffff, 32)
    );
    remuw(registers, testMemory(256n), {
      destinationRegister: 4,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 4),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 8);
  });
});
