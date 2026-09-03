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
import { createMemory, loadBytes, storeBytes } from '#memory.js';
import { signedNumberToBytes } from '#utils/bytes.js';

describe('memory', () => {
  it('createMemory uses a SharedArrayBuffer', () => {
    const memory = createMemory(64);
    assert.equal(memory.byteLength, 64);
    assert.ok(memory.buffer instanceof SharedArrayBuffer);
  });

  it('storeBytes and loadBytes round-trip', () => {
    const memory = createMemory(64);
    const eight = new Uint8Array([0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]);
    storeBytes({
      memory,
      address: signedNumberToBytes(new Uint8Array(8), 8, 32),
      source: eight,
      byteLength: 8,
    });

    const destination = new Uint8Array(8);
    loadBytes({
      destination,
      memory,
      address: signedNumberToBytes(new Uint8Array(8), 8, 32),
      byteLength: 8,
    });
    assert.deepEqual(destination, eight);
  });

  it('loadBytes zero-extends into the destination high bytes', () => {
    const memory = createMemory(64);
    memory[4] = 0xab;
    const destination = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    loadBytes({
      destination,
      memory,
      address: signedNumberToBytes(new Uint8Array(8), 4, 32),
      byteLength: 1,
    });
    assert.deepEqual(destination, new Uint8Array([0xab, 0, 0, 0, 0, 0, 0, 0]));
  });

  it('does not wrap addresses above 4GiB into low memory', () => {
    const memory = createMemory(64);
    memory[16] = 0x42;
    // 2^32 + 16 — must not alias to byte 16.
    const highAddress = new Uint8Array([0x10, 0, 0, 0, 1, 0, 0, 0]);

    const destination = new Uint8Array(8);
    loadBytes({ destination, memory, address: highAddress, byteLength: 1 });
    assert.deepEqual(destination, new Uint8Array(8));

    storeBytes({
      memory,
      address: highAddress,
      source: new Uint8Array([0xff]),
      byteLength: 1,
    });
    assert.equal(memory[16], 0x42);
  });
});
