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
import { sb, sw } from '#cpu/instructions/store.js';
import { createMemory } from '#memory.js';
import { createRegisters, writeGeneralPurposeRegister } from '#cpu/registers.js';
import { signedNumberToBytes } from '#utils/bytes.js';

describe('store', () => {
  it('sb stores the low byte', () => {
    const guest = createMemory(256);
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 3, signedNumberToBytes(0xab, 32));
    writeGeneralPurposeRegister(registers, 4, signedNumberToBytes(20, 32));
    sb(registers, guest, {
      sourceRegister1: 4,
      sourceRegister2: 3,
      immediate: signedNumberToBytes(0, 32),
    });
    assert.equal(guest[20], 0xab);
  });

  it('sw stores a word', () => {
    const guest = createMemory(256);
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 4, signedNumberToBytes(20, 32));
    writeGeneralPurposeRegister(registers, 5, signedNumberToBytes(0x44332211, 32));
    sw(registers, guest, {
      sourceRegister1: 4,
      sourceRegister2: 5,
      immediate: signedNumberToBytes(4, 32),
    });
    assert.deepEqual(guest.subarray(24, 28), Uint8Array.of(0x11, 0x22, 0x33, 0x44));
  });
});
