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
import createTestMemory from '#testing/guest-memory.js';
import { signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes.js';
import type { Memory, ReadonlyUint8Array } from '#types.js';

/** 16550 register window — matches `UART_SIZE` in memory.ts. */
const UART_SIZE = 8n;
const RAM_BASE = new Uint8Array(8) as ReadonlyUint8Array;
const UART_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x1000_0000n) as ReadonlyUint8Array;
const VIRT_RAM_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000n) as ReadonlyUint8Array;

describe('memory', () => {
  it('createMemory packs RAM and UART into one SharedArrayBuffer', () => {
    const memory = createTestMemory(64n);
    assert.equal(memory.ramSize, 64n);
    assert.equal(memory.bytes.byteLength, Number(64n + UART_SIZE));
    assert.ok(memory.bytes.buffer instanceof SharedArrayBuffer);
  });

  it('storeBytes and loadBytes round-trip in RAM', () => {
    const memory = createTestMemory(64n);
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
    const memory = createTestMemory(64n);
    memory.bytes[4] = 0xab;
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
    const memory = createTestMemory(64n);
    memory.bytes[16] = 0x42;
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
    assert.equal(memory.bytes[16], 0x42);
  });

  it('maps UART guest addresses to the packed tail of bytes', () => {
    const memory = createTestMemory(64n);
    storeBytes({
      memory,
      address: UART_BASE,
      source: new Uint8Array([0xa5]),
      byteLength: 1,
    });
    assert.equal(memory.bytes[64], 0xa5);
    assert.equal(memory.bytes[0], 0);

    const destination = new Uint8Array(8);
    loadBytes({ destination, memory, address: UART_BASE, byteLength: 1 });
    assert.deepEqual(destination, new Uint8Array([0xa5, 0, 0, 0, 0, 0, 0, 0]));
  });

  it('maps RAM at a non-zero base without allocating the guest PA hole', () => {
    const ramSize = 64n;
    const memory: Memory = {
      bytes: createMemory({
        ramBaseAddress: VIRT_RAM_BASE,
        ramSize,
        uartBaseAddress: UART_BASE,
      }),
      ramBaseAddress: VIRT_RAM_BASE,
      ramSize,
      uartBaseAddress: UART_BASE,
    };
    assert.equal(memory.bytes.byteLength, Number(64n + UART_SIZE));

    // Guest PA 0x8000_0000 + 4 → host index 4
    const ramAddress = new Uint8Array(VIRT_RAM_BASE);
    ramAddress[0] = 4;
    storeBytes({
      memory,
      address: ramAddress,
      source: new Uint8Array([0x5a]),
      byteLength: 1,
    });
    assert.equal(memory.bytes[4], 0x5a);

    // Low guest PA 4 is unmapped when RAM base is 0x8000_0000
    const low = new Uint8Array(8);
    loadBytes({
      destination: low,
      memory,
      address: signedNumberToBytes(new Uint8Array(8), 4, 32),
      byteLength: 1,
    });
    assert.deepEqual(low, new Uint8Array(8));

    storeBytes({
      memory,
      address: UART_BASE,
      source: new Uint8Array([0xc3]),
      byteLength: 1,
    });
    assert.equal(memory.bytes[64], 0xc3);
  });

  it('rejects a UART window that overlaps RAM', () => {
    assert.throws(
      () =>
        createMemory({
          ramBaseAddress: RAM_BASE,
          ramSize: 0x1000_0000n + 1n,
          uartBaseAddress: UART_BASE,
        }),
      /overlaps RAM/
    );
  });

  it('allows large RAM when UART sits below a virt-style RAM base', () => {
    const bytes = createMemory({
      ramBaseAddress: VIRT_RAM_BASE,
      ramSize: 0x1000_0000n + 1n,
      uartBaseAddress: UART_BASE,
    });
    assert.equal(bytes.byteLength, Number(0x1000_0000n + 1n + UART_SIZE));
  });
});
