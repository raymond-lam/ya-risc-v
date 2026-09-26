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
  isClintMachineSoftwarePending,
  isClintMachineTimerPending,
  isPlicMachineExternalPending,
  loadBytes,
  popUartTransmit,
  pushUartReceive,
  storeBytes,
  type Memory,
} from '#emulator/memory';
import { atomicUpdateBit } from '#emulator/memory/atomics';
import createTestMemory from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

/** Snapshot the `wfi` wake Int32 (test observation only). */
const readHartWake = (memory: Memory): number =>
  Atomics.load(new Int32Array(memory.bytes.buffer, memory.hartWakeHostIndex, 1), 0);

/** LSR bits — local to tests (not part of the public UART surface). */
const LSR_DR = 0x01;
const LSR_THRE = 0x20;
const LSR_TEMT = 0x40;

/** CLINT register offsets relative to base — local to tests. */
const CLINT_MTIMECMP_OFFSET = 0x4000n;
const CLINT_MTIME_OFFSET = 0xbff8n;

const RAM_BASE = new Uint8Array(8) as ReadonlyUint8Array;
const UART_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x1000_0000n) as ReadonlyUint8Array;
const CLINT_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_0000n) as ReadonlyUint8Array;
const PLIC_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x0c00_0000n) as ReadonlyUint8Array;
const HIGH_RAM_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000n) as ReadonlyUint8Array;

const uartAddress = (registerIndex: number): ReadonlyUint8Array => {
  const address = new Uint8Array(UART_BASE);
  address[0] = (address[0]! + registerIndex) & 0xff;
  return address as ReadonlyUint8Array;
};

describe('memory', () => {
  it('createMemory packs RAM with UART state into one SharedArrayBuffer', () => {
    const memory = createTestMemory(64n);
    assert.equal(memory.ramSize, 64n);
    assert.equal(memory.uartRegistersHostIndex, 64);
    assert.equal(memory.uartMetaHostIndex, 72);
    assert.equal(memory.clintHostBaseIndex % 8, 0);
    assert.ok(memory.bytes.byteLength > memory.clintHostBaseIndex);
    assert.ok(memory.plicHostBaseIndex >= memory.clintHostBaseIndex + 32);
    assert.equal(memory.plicHostBaseIndex % 4, 0);
    assert.equal(memory.hartWakeHostIndex % 4, 0);
    assert.ok(memory.hartWakeHostIndex >= memory.plicHostBaseIndex);
    assert.ok(memory.bytes.buffer instanceof SharedArrayBuffer);
  });

  it('createMemory 8-byte-aligns CLINT after a misaligned UART packing end', () => {
    // ramSize 1 → UART packing ends at an index ≡ 4 (mod 8); CLINT must pad to 8.
    const memory = createTestMemory(1n);
    assert.equal(memory.uartRegistersHostIndex, 1);
    assert.equal(memory.clintHostBaseIndex % 8, 0);
    assert.ok(memory.clintHostBaseIndex > memory.uartTxDataHostIndex);
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

  it('maps RAM at a non-zero base without allocating the guest physical-address hole', () => {
    const ramSize = 64n;
    const memory = createMemory({
      ramBaseAddress: HIGH_RAM_BASE,
      ramSize,
      uartBaseAddress: UART_BASE,
      clintBaseAddress: CLINT_BASE,
      plicBaseAddress: PLIC_BASE,
    });

    // Guest physical address 0x8000_0000 + 4 → host index 4
    const ramAddress = new Uint8Array(HIGH_RAM_BASE);
    ramAddress[0] = 4;
    storeBytes({
      memory,
      address: ramAddress,
      source: new Uint8Array([0x5a]),
      byteLength: 1,
    });
    assert.equal(memory.bytes[4], 0x5a);

    // Low guest physical address 4 is unmapped when RAM base is 0x8000_0000
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
          clintBaseAddress: CLINT_BASE,
          plicBaseAddress: PLIC_BASE,
        }),
      /overlaps RAM/
    );
  });

  it('allows large RAM when UART sits below a high RAM base', () => {
    const memory = createMemory({
      ramBaseAddress: HIGH_RAM_BASE,
      ramSize: 0x1000_0000n + 1n,
      uartBaseAddress: UART_BASE,
      clintBaseAddress: CLINT_BASE,
      plicBaseAddress: PLIC_BASE,
    });
    assert.ok(memory.bytes.byteLength > Number(0x1000_0000n + 1n));
  });

  it('rejects a CLINT window that overlaps RAM', () => {
    assert.throws(
      () =>
        createMemory({
          ramBaseAddress: CLINT_BASE,
          ramSize: 0xc000n,
          uartBaseAddress: UART_BASE,
          clintBaseAddress: CLINT_BASE,
          plicBaseAddress: PLIC_BASE,
        }),
      /CLINT window overlaps RAM/
    );
  });

  it('rejects a PLIC window that overlaps RAM', () => {
    assert.throws(
      () =>
        createMemory({
          ramBaseAddress: PLIC_BASE,
          ramSize: 0x201008n,
          uartBaseAddress: UART_BASE,
          clintBaseAddress: CLINT_BASE,
          plicBaseAddress: PLIC_BASE,
        }),
      /PLIC window overlaps RAM/
    );
  });
});

describe('uart queues', () => {
  it('THR store pushes TX; popUartTransmit drains; LSR reflects THRE/TEMT', () => {
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
    assert.equal(popUartTransmit(memory), 0x41);
    assert.equal(popUartTransmit(memory), null);

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
    assert.equal(popUartTransmit(memory), 0x42);
  });

  it('pushUartReceive then RBR load pops RX and clears DR', () => {
    const memory = createTestMemory(64n);
    assert.equal(pushUartReceive(memory, 0xab), true);

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
    while (pushUartReceive(memory, filled & 0xff)) {
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
    assert.equal(popUartTransmit(memory), 0);
    assert.equal(popUartTransmit(memory), 1);
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

describe('clint', () => {
  const clintAddress = (offset: bigint): ReadonlyUint8Array =>
    unsignedBigIntToBytes(new Uint8Array(8), 0x0200_0000n + offset);

  it('resets with mtimecmp all-ones so the timer is not pending', () => {
    const memory = createTestMemory(64n);
    assert.equal(isClintMachineTimerPending(memory), false);
  });

  it('msip bit 0 drives the software IRQ wire', () => {
    const memory = createTestMemory(64n);
    assert.equal(isClintMachineSoftwarePending(memory), false);

    storeBytes({
      memory,
      address: clintAddress(0n),
      source: new Uint8Array([1, 0, 0, 0]),
      byteLength: 4,
    });
    assert.equal(isClintMachineSoftwarePending(memory), true);

    const msip = new Uint8Array(8);
    loadBytes({ destination: msip, memory, address: clintAddress(0n), byteLength: 4 });
    assert.deepEqual(msip.subarray(0, 4), new Uint8Array([1, 0, 0, 0]));

    storeBytes({
      memory,
      address: clintAddress(0n),
      source: new Uint8Array([0, 0, 0, 0]),
      byteLength: 4,
    });
    assert.equal(isClintMachineSoftwarePending(memory), false);
  });

  it('msip 0→1 bumps the hart-wake Int32 for wfi', () => {
    const memory = createTestMemory(64n);
    const before = readHartWake(memory);
    storeBytes({
      memory,
      address: clintAddress(0n),
      source: new Uint8Array([1, 0, 0, 0]),
      byteLength: 4,
    });
    assert.equal(readHartWake(memory), before + 1);
    // Level stays asserted: no second notify.
    storeBytes({
      memory,
      address: clintAddress(0n),
      source: new Uint8Array([1, 0, 0, 0]),
      byteLength: 4,
    });
    assert.equal(readHartWake(memory), before + 1);
  });

  it('asserts pending when mtime is written at or above mtimecmp', () => {
    const memory = createTestMemory(64n);
    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      source: unsignedBigIntToBytes(new Uint8Array(8), 100n),
      byteLength: 8,
    });
    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIME_OFFSET),
      source: unsignedBigIntToBytes(new Uint8Array(8), 100n),
      byteLength: 8,
    });
    assert.equal(isClintMachineTimerPending(memory), true);

    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      source: unsignedBigIntToBytes(new Uint8Array(8), 10_000n),
      byteLength: 8,
    });
    assert.equal(isClintMachineTimerPending(memory), false);
  });

  it('round-trips mtimecmp through loadBytes/storeBytes', () => {
    const memory = createTestMemory(64n);
    const value = unsignedBigIntToBytes(new Uint8Array(8), 0x0123_4567_89ab_cdefn);
    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      source: value,
      byteLength: 8,
    });
    const destination = new Uint8Array(8);
    loadBytes({
      destination,
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      byteLength: 8,
    });
    assert.deepEqual(destination, value);
  });
});

describe('plic', () => {
  /** UART external interrupt identity (source 10). */
  const PLIC_SOURCE_UART = 10;
  /** Host byte offset of the pending bitfield (`priority×32 × 4`). */
  const PLIC_HOST_PENDING = 128;

  const plicAddress = (offset: bigint): ReadonlyUint8Array =>
    unsignedBigIntToBytes(new Uint8Array(8), 0x0c00_0000n + offset);

  const storePlicUint32 = (
    memory: ReturnType<typeof createTestMemory>,
    offset: bigint,
    value: number
  ): void => {
    storeBytes({
      memory,
      address: plicAddress(offset),
      source: unsignedBigIntToBytes(new Uint8Array(8), BigInt(value >>> 0)),
      byteLength: 4,
    });
  };

  const loadPlicUint32 = (memory: ReturnType<typeof createTestMemory>, offset: bigint): number => {
    const destination = new Uint8Array(8);
    loadBytes({
      destination,
      memory,
      address: plicAddress(offset),
      byteLength: 4,
    });
    return (
      destination[0]! | (destination[1]! << 8) | (destination[2]! << 16) | (destination[3]! << 24)
    );
  };

  /**
   * Device-driven pending (guest MMIO cannot set it). Re-stores M enable so context wires refresh.
   */
  const setUartPending = (memory: Memory, pending: boolean): void => {
    atomicUpdateBit({
      bytes: memory.bytes,
      index: memory.plicHostBaseIndex + PLIC_HOST_PENDING + (PLIC_SOURCE_UART >> 3),
      bit: PLIC_SOURCE_UART & 7,
      value: pending,
    });
    storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART);
  };

  it('UART source + M enable/priority above threshold asserts MEIP wire', () => {
    const memory = createTestMemory(64n);
    assert.equal(isPlicMachineExternalPending(memory), false);

    storePlicUint32(memory, BigInt(PLIC_SOURCE_UART * 4), 7); // priority
    storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART); // enable M
    storePlicUint32(memory, 0x200000n, 0); // threshold
    setUartPending(memory, true);

    assert.equal(isPlicMachineExternalPending(memory), true);
    assert.equal(loadPlicUint32(memory, 0x1000n) & (1 << PLIC_SOURCE_UART), 1 << PLIC_SOURCE_UART);
  });

  it('claim returns the UART id and clears the MEIP wire until complete', () => {
    const memory = createTestMemory(64n);
    storePlicUint32(memory, BigInt(PLIC_SOURCE_UART * 4), 1);
    storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART);
    setUartPending(memory, true);
    assert.equal(isPlicMachineExternalPending(memory), true);

    assert.equal(loadPlicUint32(memory, 0x200004n), PLIC_SOURCE_UART);
    assert.equal(isPlicMachineExternalPending(memory), false);

    // Still pending at the source, but claimed — complete re-arms the wire.
    storePlicUint32(memory, 0x200004n, PLIC_SOURCE_UART);
    assert.equal(isPlicMachineExternalPending(memory), true);
  });

  it('source 0→1 bumps the hart-wake Int32', () => {
    const memory = createTestMemory(64n);
    storePlicUint32(memory, BigInt(PLIC_SOURCE_UART * 4), 1);
    storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART);
    const before = readHartWake(memory);
    setUartPending(memory, true);
    assert.equal(readHartWake(memory), before + 1);
    setUartPending(memory, true);
    assert.equal(readHartWake(memory), before + 1);
  });

  it('pending is not CSR/MMIO-writable', () => {
    const memory = createTestMemory(64n);
    storePlicUint32(memory, 0x1000n, 0xffff_ffff);
    assert.equal(loadPlicUint32(memory, 0x1000n), 0);
  });
});
