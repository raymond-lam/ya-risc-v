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
import {
  createMemory,
  loadBytes,
  popTransmit,
  pushReceive,
  storeBytes,
  type Memory,
  type ReadonlyUint8Array,
} from '#emulator/memory';
import createTestMemory from '#test/guest-memory';
import { signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

/** LSR bits — local to tests (not part of the public UART surface). */
const LSR_DR = 0x01;
const LSR_THRE = 0x20;
const LSR_TEMT = 0x40;

const RAM_BASE = new Uint8Array(8) as ReadonlyUint8Array;
const UART_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x1000_0000n) as ReadonlyUint8Array;
const VIRT_RAM_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000n) as ReadonlyUint8Array;

const uartAddress = (registerIndex: number): ReadonlyUint8Array => {
  const address = new Uint8Array(UART_BASE);
  address[0] = (address[0]! + registerIndex) & 0xff;
  return address as ReadonlyUint8Array;
};

describe('memory', () => {
  it('createMemory packs RAM with UART state into one SharedArrayBuffer', () => {
    const memory = createTestMemory(64n);
    assert.equal(memory.ramSize, 64n);
    assert.ok(memory.bytes.byteLength > Number(64n + 8n));
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
    assert.ok(bytes.byteLength > Number(0x1000_0000n + 1n));
  });
});

describe('uart queues', () => {
  it('THR store pushes TX; popTransmit drains; LSR reflects THRE/TEMT', () => {
    const memory = createTestMemory(64n);

    const lsrEmpty = new Uint8Array(8);
    loadBytes({ destination: lsrEmpty, memory, address: uartAddress(5), byteLength: 1 });
    assert.equal(lsrEmpty[0], LSR_THRE | LSR_TEMT);

    storeBytes({
      memory,
      address: uartAddress(0),
      source: new Uint8Array([0x41]),
      byteLength: 1,
    });
    assert.equal(popTransmit(memory), 0x41);
    assert.equal(popTransmit(memory), null);

    storeBytes({
      memory,
      address: uartAddress(0),
      source: new Uint8Array([0x42]),
      byteLength: 1,
    });
    const lsrPending = new Uint8Array(8);
    loadBytes({ destination: lsrPending, memory, address: uartAddress(5), byteLength: 1 });
    assert.equal(lsrPending[0]! & LSR_TEMT, 0);
    assert.equal(lsrPending[0]! & LSR_THRE, LSR_THRE);
    assert.equal(popTransmit(memory), 0x42);
  });

  it('pushReceive then RBR load pops RX and clears DR', () => {
    const memory = createTestMemory(64n);
    assert.equal(pushReceive(memory, 0xab), true);

    const lsrReady = new Uint8Array(8);
    loadBytes({ destination: lsrReady, memory, address: uartAddress(5), byteLength: 1 });
    assert.equal(lsrReady[0]! & LSR_DR, LSR_DR);

    const rbr = new Uint8Array(8);
    loadBytes({ destination: rbr, memory, address: uartAddress(0), byteLength: 1 });
    assert.equal(rbr[0], 0xab);

    const lsrAfter = new Uint8Array(8);
    loadBytes({ destination: lsrAfter, memory, address: uartAddress(5), byteLength: 1 });
    assert.equal(lsrAfter[0]! & LSR_DR, 0);

    const emptyRbr = new Uint8Array(8);
    loadBytes({ destination: emptyRbr, memory, address: uartAddress(0), byteLength: 1 });
    assert.equal(emptyRbr[0], 0);
  });

  it('drops RX when the receive queue is full', () => {
    const memory = createTestMemory(64n);
    let filled = 0;
    while (pushReceive(memory, filled & 0xff)) {
      filled += 1;
    }
    assert.ok(filled > 0);

    const first = new Uint8Array(8);
    loadBytes({ destination: first, memory, address: uartAddress(0), byteLength: 1 });
    assert.equal(first[0], 0);
  });

  it('drops TX when the transmit queue is full', () => {
    const memory = createTestMemory(64n);
    let filled = 0;
    for (;;) {
      storeBytes({
        memory,
        address: uartAddress(0),
        source: new Uint8Array([filled & 0xff]),
        byteLength: 1,
      });
      const lsr = new Uint8Array(8);
      loadBytes({ destination: lsr, memory, address: uartAddress(5), byteLength: 1 });
      filled += 1;
      if ((lsr[0]! & LSR_THRE) === 0) {
        break;
      }
      assert.ok(filled < 64);
    }

    storeBytes({
      memory,
      address: uartAddress(0),
      source: new Uint8Array([0xff]),
      byteLength: 1,
    });
    assert.equal(popTransmit(memory), 0);
    assert.equal(popTransmit(memory), 1);
  });

  it('round-trips scratch and ignores LSR writes', () => {
    const memory = createTestMemory(64n);
    storeBytes({
      memory,
      address: uartAddress(7),
      source: new Uint8Array([0x5a]),
      byteLength: 1,
    });
    const scratch = new Uint8Array(8);
    loadBytes({ destination: scratch, memory, address: uartAddress(7), byteLength: 1 });
    assert.equal(scratch[0], 0x5a);

    storeBytes({
      memory,
      address: uartAddress(5),
      source: new Uint8Array([0xff]),
      byteLength: 1,
    });
    const lsr = new Uint8Array(8);
    loadBytes({ destination: lsr, memory, address: uartAddress(5), byteLength: 1 });
    assert.equal(lsr[0], LSR_THRE | LSR_TEMT);
  });
});
