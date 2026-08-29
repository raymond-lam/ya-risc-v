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
import { beq, bne, blt } from '#cpu/instructions/branch.js';
import { createMemory } from '#memory.js';
import {
  createRegisters,
  readProgramCounter,
  setProgramCounter,
  writeGeneralPurposeRegister,
} from '#cpu/registers.js';
import { bytesToNumber, signedNumberToBytes } from '#utils/bytes.js';

describe('branch', () => {
  it('beq branches when equal', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(100, 32));
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(5, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(5, 32));
    beq(registers, createMemory(256), {
      sourceRegister1: 1,
      sourceRegister2: 2,
      immediate: signedNumberToBytes(16, 32),
    });
    assert.equal(bytesToNumber(readProgramCounter(registers)), 116);
  });

  it('bne falls through when equal', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(100, 32));
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(5, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(5, 32));
    bne(registers, createMemory(256), {
      sourceRegister1: 1,
      sourceRegister2: 2,
      immediate: signedNumberToBytes(16, 32),
    });
    assert.equal(bytesToNumber(readProgramCounter(registers)), 104);
  });

  it('blt branches on signed less-than', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(200, 32));
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(-1, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(0, 32));
    blt(registers, createMemory(256), {
      sourceRegister1: 1,
      sourceRegister2: 2,
      immediate: signedNumberToBytes(8, 32),
    });
    assert.equal(bytesToNumber(readProgramCounter(registers)), 208);
  });
});
