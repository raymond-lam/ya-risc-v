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
import { addw } from '#cpu/instructions/op-32.js';
import { createMemory } from '#memory.js';
import {
  createRegisters,
  readGeneralPurposeRegister,
  writeGeneralPurposeRegister,
} from '#cpu/registers.js';
import { signedNumberToBytes } from '#utils/bytes.js';

describe('op-32', () => {
  it('addw wraps and sign-extends within 32 bits', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(
      registers,
      1,
      signedNumberToBytes(new Uint8Array(8), 0xffffffff, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 1, 32));
    addw(registers, createMemory(256), {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
  });
});
