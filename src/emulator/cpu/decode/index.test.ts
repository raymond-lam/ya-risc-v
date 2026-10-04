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
import decode from '#emulator/cpu/decode';
import {
  createRegisters,
  readProgramCounter,
  setProgramCounter,
  FOUR_BYTES,
} from '#emulator/cpu/registers';
import createTestMemory from '#test/guest-memory';
import { signedNumberToBytes } from '#utils/bytes';

/** Pack a 32-bit instruction encoding as little-endian bytes. */
const instructionBytes = (encoding: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  bytes[0] = encoding & 0xff;
  bytes[1] = (encoding >>> 8) & 0xff;
  bytes[2] = (encoding >>> 16) & 0xff;
  bytes[3] = (encoding >>> 24) & 0xff;
  return bytes;
};

describe('decode cache', () => {
  it('stays bounded when decoding many unique encodings', () => {
    // Walk far more unique 32-bit encodings than the LRU cap; must not throw.
    for (let encoding = 0; encoding < 20_000; encoding += 1) {
      // Force 32-bit encodings (low two bits = 0b11) with varying upper bits.
      const word = instructionBytes((encoding << 2) | 0x3);
      const [execute, instructionByteLength] = decode(word);
      assert.equal(typeof execute, 'function');
      assert.equal(instructionByteLength, FOUR_BYTES);
    }
    // After eviction pressure, a common encoding still decodes and executes.
    const registers = createRegisters();
    const memory = createTestMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0, 32));
    const addi = instructionBytes(0x0000_0013);
    const [execute] = decode(addi);
    execute(registers, memory, FOUR_BYTES);
    assert.deepEqual(readProgramCounter(registers), signedNumberToBytes(new Uint8Array(8), 4, 32));
  });
});
