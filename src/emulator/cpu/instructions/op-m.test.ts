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
import { mul, mulh, mulhsu, mulhu, div, divu, rem, remu } from '#emulator/cpu/instructions/op-m';
import {
  createRegisters,
  readGeneralPurposeRegister,
  readProgramCounter,
  writeGeneralPurposeRegister,
} from '#emulator/cpu/registers';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

describe('op-m', () => {
  it('mul writes the low half and advances pc', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 6, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 7, 32));
    mul(registers, testMemory(256n), {
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

  it('mulh, mulhsu, and mulhu return the high half of a wide product', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(
      registers,
      1,
      unsignedBigIntToBytes(new Uint8Array(8), 0xffff_ffff_ffff_ffffn)
    );
    writeGeneralPurposeRegister(
      registers,
      2,
      unsignedBigIntToBytes(new Uint8Array(8), 0xffff_ffff_ffff_ffffn)
    );
    mulhu(registers, testMemory(256n), {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      unsignedBigIntToBytes(new Uint8Array(8), 0xffff_ffff_ffff_fffen)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);

    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), -1, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), -1, 32));
    mulh(registers, testMemory(256n), {
      destinationRegister: 4,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 4),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );

    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), -2, 32));
    writeGeneralPurposeRegister(
      registers,
      2,
      unsignedBigIntToBytes(new Uint8Array(8), 0xffff_ffff_ffff_ffffn)
    );
    mulhsu(registers, testMemory(256n), {
      destinationRegister: 5,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 5),
      signedNumberToBytes(new Uint8Array(8), -2, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 12);
  });

  it('div and rem follow RISC-V divide-by-zero and overflow rules', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 20, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0, 32));
    div(registers, testMemory(256n), {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), -1, 32)
    );
    rem(registers, testMemory(256n), {
      destinationRegister: 4,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 4),
      signedNumberToBytes(new Uint8Array(8), 20, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 8);

    writeGeneralPurposeRegister(
      registers,
      1,
      unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000_0000_0000n)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), -1, 32));
    div(registers, testMemory(256n), {
      destinationRegister: 5,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 5),
      unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000_0000_0000n)
    );
    rem(registers, testMemory(256n), {
      destinationRegister: 6,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 6),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
  });

  it('divu and remu treat sources as unsigned', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(
      registers,
      1,
      unsignedBigIntToBytes(new Uint8Array(8), 0xffff_ffff_ffff_ffffn)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 2, 32));
    divu(registers, testMemory(256n), {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      unsignedBigIntToBytes(new Uint8Array(8), 0x7fff_ffff_ffff_ffffn)
    );
    remu(registers, testMemory(256n), {
      destinationRegister: 4,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 4),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 8);
  });
});
