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
import { addiw } from '#cpu/instructions/op-imm-32.js';
import { createMemory } from '#memory.js';
import {
  createRegisters,
  readGeneralPurposeRegister,
  writeGeneralPurposeRegister,
} from '#cpu/registers.js';
import { signedNumberToBytes } from '#utils/bytes.js';

describe('op-imm-32', () => {
  it('addiw sign-extends the 32-bit sum', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(
      registers,
      1,
      signedNumberToBytes(new Uint8Array(8), 0x7fffffff, 32)
    );
    addiw(registers, createMemory(256), {
      destinationRegister: 2,
      sourceRegister1: 1,
      immediate: signedNumberToBytes(new Uint8Array(8), 1, 32),
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 0x80000000, 32)
    );
    assert.equal(readGeneralPurposeRegister(registers, 2)[7], 0xff);
  });
});
