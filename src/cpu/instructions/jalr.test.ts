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
import { jalr } from '#cpu/instructions/jalr.js';
import { createMemory } from '#memory.js';
import {
  createRegisters,
  readGeneralPurposeRegister,
  readProgramCounter,
  setProgramCounter,
  writeGeneralPurposeRegister,
} from '#cpu/registers.js';
import { bytesToNumber, signedNumberToBytes } from '#utils/bytes.js';

describe('jalr', () => {
  it('links and clears the target least-significant bit', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 100, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x21, 32));
    jalr(registers, createMemory(256), {
      destinationRegister: 1,
      sourceRegister1: 2,
      immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 104, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x20);
  });
});
