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
import { lb, lbu, lw } from '#cpu/instructions/load.js';
import { createMemory } from '#memory.js';
import {
  createRegisters,
  readGeneralPurposeRegister,
  writeGeneralPurposeRegister,
} from '#cpu/registers.js';
import { signedNumberToBytes } from '#utils/bytes.js';

describe('load', () => {
  it('lb sign-extends and lbu zero-extends', () => {
    const guest = createMemory(256);
    guest[10] = 0x80;
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(10, 32));

    lb(registers, guest, {
      destinationRegister: 1,
      sourceRegister1: 2,
      immediate: signedNumberToBytes(0, 32),
    });
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), signedNumberToBytes(-128, 32));

    lbu(registers, guest, {
      destinationRegister: 3,
      sourceRegister1: 2,
      immediate: signedNumberToBytes(0, 32),
    });
    assert.deepEqual(readGeneralPurposeRegister(registers, 3), signedNumberToBytes(0x80, 32));
  });

  it('lw loads a word', () => {
    const guest = createMemory(256);
    guest[8] = 0x78;
    guest[9] = 0x56;
    guest[10] = 0x34;
    guest[11] = 0x12;
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(8, 32));

    lw(registers, guest, {
      destinationRegister: 1,
      sourceRegister1: 2,
      immediate: signedNumberToBytes(0, 32),
    });
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), signedNumberToBytes(0x12345678, 32));
  });

  it('lb does not wrap a 2^32+offset address into low memory', () => {
    const guest = createMemory(256);
    guest[16] = 0x42;
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 2, new Uint8Array([0x10, 0, 0, 0, 1, 0, 0, 0]));

    lb(registers, guest, {
      destinationRegister: 1,
      sourceRegister1: 2,
      immediate: signedNumberToBytes(0, 32),
    });
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), signedNumberToBytes(0, 32));
  });
});
