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
import { add, sub, slt, xor } from '#cpu/instructions/op.js';
import { createMemory } from '#memory.js';
import {
  createRegisters,
  readGeneralPurposeRegister,
  writeGeneralPurposeRegister,
} from '#cpu/registers.js';
import { signedNumberToBytes } from '#utils/bytes.js';

describe('op', () => {
  it('add and sub combine two registers', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(20, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(7, 32));

    add(registers, createMemory(256), {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(readGeneralPurposeRegister(registers, 3), signedNumberToBytes(27, 32));

    sub(registers, createMemory(256), {
      destinationRegister: 4,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(readGeneralPurposeRegister(registers, 4), signedNumberToBytes(13, 32));
  });

  it('slt sets rd from a signed comparison', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(-2, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(1, 32));
    slt(registers, createMemory(256), {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(readGeneralPurposeRegister(registers, 3), signedNumberToBytes(1, 32));
  });

  it('xor combines two registers', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(0xaa, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(0x55, 32));
    xor(registers, createMemory(256), {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(readGeneralPurposeRegister(registers, 3), signedNumberToBytes(0xff, 32));
  });
});
