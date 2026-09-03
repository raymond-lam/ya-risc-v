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
import { addi, slti, sltiu, xori } from '#cpu/instructions/op-imm.js';
import { createMemory } from '#memory.js';
import {
  createRegisters,
  readGeneralPurposeRegister,
  readProgramCounter,
  writeGeneralPurposeRegister,
} from '#cpu/registers.js';
import { bytesToNumber, signedNumberToBytes } from '#utils/bytes.js';

describe('op-imm', () => {
  it('addi writes rs1 + imm and advances pc', () => {
    const registers = createRegisters();
    addi(registers, createMemory(256), {
      destinationRegister: 1,
      sourceRegister1: 0,
      immediate: signedNumberToBytes(new Uint8Array(8), 10, 32),
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 10, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('slti and sltiu compare signed vs unsigned', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), -1, 32));

    slti(registers, createMemory(256), {
      destinationRegister: 2,
      sourceRegister1: 1,
      immediate: signedNumberToBytes(new Uint8Array(8), 1, 32),
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );

    sltiu(registers, createMemory(256), {
      destinationRegister: 3,
      sourceRegister1: 1,
      immediate: signedNumberToBytes(new Uint8Array(8), 1, 32),
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
  });

  it('xori bitwise-xors the immediate', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0x0f, 32));
    xori(registers, createMemory(256), {
      destinationRegister: 2,
      sourceRegister1: 1,
      immediate: signedNumberToBytes(new Uint8Array(8), 0xff, 32),
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 0xf0, 32)
    );
  });
});
