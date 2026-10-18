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
import decode from '#emulator/cpu/decode';
import { fence, fenceI } from '#emulator/cpu/instructions/misc-mem';
import { createRegisters, readProgramCounter, FOUR_BYTES } from '#emulator/cpu/registers';
import { bytesToNumber } from '#utils/bytes';

/** Pack a 32-bit instruction encoding as little-endian bytes. */
const instructionBytes = (encoding: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  bytes[0] = encoding & 0xff;
  bytes[1] = (encoding >>> 8) & 0xff;
  bytes[2] = (encoding >>> 16) & 0xff;
  bytes[3] = (encoding >>> 24) & 0xff;
  return bytes;
};

describe('misc-mem', () => {
  it('fence advances pc', () => {
    const registers = createRegisters();
    fence(registers, testMemory(256n), FOUR_BYTES);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('fence.i advances pc', () => {
    const registers = createRegisters();
    fenceI(registers, testMemory(256n), FOUR_BYTES);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('decodes fence.i and advances pc', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    const [execute, instructionByteLength] = decode(instructionBytes(0x0000100f));
    execute(registers, memory, instructionByteLength);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });
});
