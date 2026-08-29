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
import { ebreak, ecall } from '#cpu/instructions/system.js';
import { createMemory } from '#memory.js';
import { createRegisters } from '#cpu/registers.js';

describe('system', () => {
  it('ecall and ebreak throw', () => {
    const registers = createRegisters();
    const guest = createMemory(256);
    assert.throws(() => ecall(registers, guest), /Environment call/);
    assert.throws(() => ebreak(registers, guest), /Breakpoint/);
  });
});
