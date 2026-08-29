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
import fence from '#cpu/instructions/misc-mem.js';
import { createMemory } from '#memory.js';
import { createRegisters, readProgramCounter } from '#cpu/registers.js';
import { bytesToNumber } from '#utils/bytes.js';

describe('misc-mem', () => {
  it('fence advances pc', () => {
    const registers = createRegisters();
    fence(registers, createMemory(256));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });
});
