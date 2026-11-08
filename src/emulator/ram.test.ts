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
import { Worker } from 'node:worker_threads';
import { describe, it } from 'node:test';
import { atomicCompareExchangeBytes, loadBytes, storeBytes, type Memory } from '#emulator/memory';
import { guestRamOffset, loadBytesFromRam, RAM_REGION_ID, storeBytesToRam } from '#emulator/ram';
import {
  RESERVATION_REGION_ID,
  reservationLockIndex,
  setReservationLocked,
} from '#emulator/reservation';
import withSharedLocks from '#emulator/with-shared-locks';
import { bigIntAsNumber } from '#utils/int';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes } from '#utils/bytes';
import createTestMemory from '#test/guest-memory';

const guest = (offset: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), offset) as ReadonlyUint8Array;

/** Arm a reservation under the monitor lock (mirrors production LR path). */
const setReservation = async (
  memory: Memory,
  hartId: number,
  address: ReadonlyUint8Array,
  byteLength: number
): Promise<void> => {
  await withSharedLocks(memory.bytes, [reservationLockIndex(memory)], () => {
    setReservationLocked(memory, hartId, address, byteLength);
  });
};

/** Mirror the production DMA store: gate on `guestRamOffset`, then copy under the lock. */
const storeGuestRamBytes = async (
  args: Omit<Parameters<typeof storeBytesToRam>[0], 'offset'>
): Promise<boolean> => {
  let stored = false;
  await withSharedLocks(args.memory.bytes, [reservationLockIndex(args.memory)], () => {
    const offset = guestRamOffset(args.memory, args.address, args.byteLength);
    if (offset === null) {
      return;
    }
    storeBytesToRam({ ...args, offset });
    stored = true;
  });
  return stored;
};

/** Observe whether hart `hartId`'s slot is valid (test-only). */
const slotValid = (memory: Memory, hartId: number): boolean => {
  const region = memory.regions.get(RESERVATION_REGION_ID);
  assert.ok(region);
  const slotBase = bigIntAsNumber(region.hostIndex) + 8 + hartId * 16;
  return Atomics.load(new Int32Array(memory.bytes.buffer, slotBase, 1), 0) !== 0;
};

describe('guest RAM DMA', () => {
  it('guestRamOffset maps in-window addresses to their offset', () => {
    const memory = createTestMemory(256n);
    assert.equal(guestRamOffset(memory, guest(4n), 4), 4n);
    assert.equal(guestRamOffset(memory, guest(0xf8n), 8), 0xf8n); // ends exactly on the boundary
    assert.equal(guestRamOffset(memory, guest(0xfcn), 4), 0xfcn);
  });

  it('guestRamOffset rejects out-of-window and straddling ranges', () => {
    const memory = createTestMemory(256n);
    assert.equal(guestRamOffset(memory, guest(0x100n), 4), null); // starts one past the end
    // The start address is in RAM but the transfer runs off the end: DMA must not truncate.
    assert.equal(guestRamOffset(memory, guest(0xfcn), 8), null);
  });

  it('loadBytesFromRam copies from the resolved offset and zero-fills past the addressable prefix', () => {
    const memory = createTestMemory(256n);
    const ram = memory.regions.get(RAM_REGION_ID);
    assert.ok(ram);
    memory.bytes.set(
      new Uint8Array([0x11, 0x22, 0x33, 0x44]),
      bigIntAsNumber(ram.hostIndex) + 0xfc
    );
    const destination = new Uint8Array(4).fill(0xaa);
    loadBytesFromRam({ destination, memory, address: guest(0xfcn), offset: 0xfcn, byteLength: 4 });
    assert.deepEqual(destination, new Uint8Array([0x11, 0x22, 0x33, 0x44]));
    // memory.loadBytes clears the destination first, so a straddling copy must leave the tail zero.
    const straddling = new Uint8Array(8).fill(0xaa);
    loadBytesFromRam({
      destination: straddling,
      memory,
      address: guest(0xfcn),
      offset: 0xfcn,
      byteLength: 8,
    });
    assert.deepEqual(straddling, new Uint8Array([0x11, 0x22, 0x33, 0x44, 0, 0, 0, 0]));
  });

  it('storeGuestRamBytes writes exactly and returns true', async () => {
    const memory = createTestMemory(256n);
    const ok = await storeGuestRamBytes({
      memory,
      address: guest(8n),
      source: new Uint8Array([0xde, 0xad]),
      byteLength: 2,
    });
    assert.equal(ok, true);
    const readback = new Uint8Array(2);
    await loadBytes({ destination: readback, memory, address: guest(8n), byteLength: 2 });
    assert.deepEqual(readback, new Uint8Array([0xde, 0xad]));
  });

  it('storeGuestRamBytes invalidates an overlapping reservation', async () => {
    const memory = createTestMemory(256n);
    await setReservation(memory, 0, guest(0n), 8);
    assert.equal(slotValid(memory, 0), true);
    const ok = await storeGuestRamBytes({
      memory,
      address: guest(0x10n),
      source: new Uint8Array([0x01]),
      byteLength: 1,
    });
    assert.equal(ok, true);
    assert.equal(slotValid(memory, 0), false);
  });

  it('storeGuestRamBytes rejects non-RAM targets without touching RAM', async () => {
    const memory = createTestMemory(256n);
    await storeBytes({ memory, address: guest(0n), source: new Uint8Array([0x5a]), byteLength: 1 });
    assert.equal(
      await storeGuestRamBytes({
        memory,
        address: guest(0x800n),
        source: new Uint8Array([0x99]),
        byteLength: 1,
      }),
      false
    );
    const canary = new Uint8Array(1);
    await loadBytes({ destination: canary, memory, address: guest(0n), byteLength: 1 });
    assert.deepEqual(canary, new Uint8Array([0x5a]));
  });
});

describe('aligned RAM access', () => {
  it('preserves neighbors and hides padded tail from guest reads', async () => {
    const memory = createTestMemory(9n);
    await storeBytes({
      memory,
      address: guest(0n),
      source: new Uint8Array(9).fill(0xa5),
      byteLength: 9,
    });
    await storeBytes({
      memory,
      address: guest(7n),
      source: new Uint8Array([0x12, 0x34, 0x56]),
      byteLength: 3,
    });
    const data = new Uint8Array(12);
    await loadBytes({ memory, address: guest(0n), destination: data, byteLength: 12 });
    assert.deepEqual(
      data,
      new Uint8Array([0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0x12, 0x34, 0, 0, 0])
    );
    const ram = memory.regions.get(RAM_REGION_ID);
    assert.ok(ram);
    assert.deepEqual(
      memory.bytes.subarray(Number(ram.hostIndex) + 9, Number(ram.hostIndex) + 16),
      new Uint8Array(7)
    );
    // Upper-half 32-bit CAS lands in the enclosing 64-bit word's bytes 4..7 and keeps
    // bytes 0..3 and 8.
    const observed = new Uint8Array(4);
    assert.equal(
      await atomicCompareExchangeBytes({
        destination: observed,
        memory,
        address: guest(4n),
        byteLength: 4,
        expected: new Uint8Array([0xa5, 0xa5, 0xa5, 0x12]),
        desired: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
      }),
      true
    );
    assert.deepEqual(
      memory.bytes.subarray(Number(ram.hostIndex), Number(ram.hostIndex) + 9),
      new Uint8Array([0xa5, 0xa5, 0xa5, 0xa5, 0x01, 0x02, 0x03, 0x04, 0x34])
    );
  });
  it(
    'does not tear u16 rollover under concurrent 2/4/8-byte polling',
    { timeout: 5000 },
    async () => {
      const memory = createTestMemory(64n);
      await storeBytes({
        memory,
        address: guest(0n),
        source: new Uint8Array([0xa5, 0xa5, 0xff, 0, 0xa5, 0xa5, 0xa5, 0xa5]),
        byteLength: 8,
      });
      const worker = new Worker(
        `
      const {parentPort,workerData} = await import('node:worker_threads');
      const {storeBytesToRam} = await import(workerData.ramUrl);
      const {reservationLockIndex} = await import(workerData.reservationUrl);
      const {default: withSharedLocks} = await import(workerData.locksUrl);
      parentPort.on('message', async () => {
        for (let i=0;i<20000;i++) await withSharedLocks(workerData.memory.bytes,
          [reservationLockIndex(workerData.memory)], () => storeBytesToRam({memory:workerData.memory,
          address:new Uint8Array([2,0,0,0,0,0,0,0]), offset:2n,
          source: i%2 ? new Uint8Array([0xff,0]) : new Uint8Array([0,1]), byteLength:2}));
        parentPort.postMessage('done');
      });
      parentPort.postMessage('ready');
    `,
        {
          eval: true,
          execArgv: ['--import', 'tsx', '--conditions', '@ya-risc-v/source'],
          workerData: {
            memory,
            ramUrl: new URL('./ram.ts', import.meta.url).href,
            reservationUrl: new URL('./reservation.ts', import.meta.url).href,
            locksUrl: new URL('./with-shared-locks.ts', import.meta.url).href,
          },
        }
      );
      try {
        await new Promise<void>((resolve, reject) => {
          worker.once('message', () => resolve());
          worker.once('error', reject);
        });
        let done = false;
        const completion = new Promise<void>((resolve, reject) => {
          worker.once('message', () => {
            done = true;
            resolve();
          });
          worker.once('error', reject);
        });
        worker.postMessage('go');
        let samples = 0;
        while (!done) {
          for (const width of [2, 4, 8]) {
            const data = new Uint8Array(width);
            await loadBytes({
              memory,
              address: guest(width === 2 ? 2n : 0n),
              destination: data,
              byteLength: width,
            });
            const offset = width === 2 ? 0 : 2;
            const index = data[offset]! | (data[offset + 1]! << 8);
            assert.ok(index === 255 || index === 256, `torn index ${index}`);
            if (width !== 2) assert.deepEqual(data.subarray(0, 2), new Uint8Array([0xa5, 0xa5]));
            samples++;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await completion;
        assert.ok(samples > 0);
      } finally {
        await worker.terminate();
      }
    }
  );
});
