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
import { Worker } from 'node:worker_threads';
import withSharedLocks from '#emulator/with-shared-locks';
import {
  atomicLoadReservedBytes,
  atomicStoreConditionalBytes,
  storeBytes,
  type Memory,
} from '#emulator/memory';
import {
  invalidateOverlappingReservationsLocked,
  reservationLockIndex,
  RESERVATION_REGION_ID,
  setReservationLocked,
  tryTakeReservation,
} from '#emulator/reservation';
import { bigIntAsNumber } from '#utils/int';
import createTestMemory from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { signedNumberToBytes } from '#utils/bytes';

const addressAt = (offset: number): ReadonlyUint8Array =>
  signedNumberToBytes(new Uint8Array(8), offset, 32);

const setReservation = (
  memory: Memory,
  hartId: number,
  address: ReadonlyUint8Array,
  byteLength: number
): Promise<void> =>
  withSharedLocks(memory.bytes, [reservationLockIndex(memory)], () =>
    setReservationLocked(memory, hartId, address, byteLength)
  );

const slotValid = (memory: Memory, hartId: number): boolean => {
  const region = memory.regions.get(RESERVATION_REGION_ID);
  assert.ok(region);
  const slotBase = bigIntAsNumber(region.hostIndex) + 8 + hartId * 16;
  return Atomics.load(new Int32Array(memory.bytes.buffer, slotBase, 1), 0) !== 0;
};

describe('reservation monitor', () => {
  it('a reservation on the same line clears the other hart slot', async () => {
    const memory = createTestMemory(256n);
    await setReservation(memory, 0, addressAt(0), 8);
    assert.equal(slotValid(memory, 0), true);
    await setReservation(memory, 1, addressAt(8), 8);
    assert.equal(slotValid(memory, 0), false);
    assert.equal(slotValid(memory, 1), true);
    await withSharedLocks(memory.bytes, [reservationLockIndex(memory)], () => {
      assert.equal(tryTakeReservation(memory, 0, addressAt(0), 8), false);
      assert.equal(tryTakeReservation(memory, 1, addressAt(8), 8), true);
      assert.equal(slotValid(memory, 1), false);
    });
  });

  it('a mismatched SC clears its reservation', async () => {
    const memory = createTestMemory(256n);
    await setReservation(memory, 0, addressAt(0), 8);
    await withSharedLocks(memory.bytes, [reservationLockIndex(memory)], () => {
      assert.equal(tryTakeReservation(memory, 0, addressAt(64), 8), false);
    });
    assert.equal(slotValid(memory, 0), false);
  });

  it('LR and an overlapping store serialize the load with its reservation', async () => {
    const memory = createTestMemory(256n);
    const address = addressAt(32);
    const destination = new Uint8Array(8);
    let reservedLoad: Promise<boolean> | undefined;
    let competingStore: Promise<void> | undefined;
    await withSharedLocks(memory.bytes, [reservationLockIndex(memory)], () => {
      reservedLoad = atomicLoadReservedBytes({
        destination,
        memory,
        address,
        byteLength: 4,
        hartId: 0,
      });
      competingStore = storeBytes({
        memory,
        address,
        source: new Uint8Array([0x7b]),
        byteLength: 1,
      });
      assert.equal(slotValid(memory, 0), false);
      assert.equal(destination[0], 0);
    });
    assert.ok(reservedLoad);
    assert.ok(competingStore);
    const [loaded] = await Promise.all([reservedLoad, competingStore]);
    assert.equal(loaded, true);
    assert.ok(destination[0] === 0 || destination[0] === 0x7b);
    assert.equal(slotValid(memory, 0), destination[0] === 0x7b);
    assert.equal(memory.bytes[32], 0x7b);
  });

  it('SC and an overlapping store serialize without losing the store', async () => {
    const memory = createTestMemory(256n);
    const address = addressAt(32);
    await setReservation(memory, 0, address, 4);
    let conditionalStore: Promise<boolean> | undefined;
    let competingStore: Promise<void> | undefined;
    await withSharedLocks(memory.bytes, [reservationLockIndex(memory)], () => {
      conditionalStore = atomicStoreConditionalBytes({
        memory,
        address,
        source: new Uint8Array([0x44]),
        byteLength: 4,
        hartId: 0,
      });
      competingStore = storeBytes({
        memory,
        address,
        source: new Uint8Array([0xab]),
        byteLength: 1,
      });
      assert.equal(memory.bytes[32], 0);
      assert.equal(slotValid(memory, 0), true);
    });
    assert.ok(conditionalStore);
    assert.ok(competingStore);
    await Promise.all([conditionalStore, competingStore]);
    assert.deepEqual(memory.bytes.slice(32, 36), new Uint8Array([0xab, 0, 0, 0]));
    assert.equal(slotValid(memory, 0), false);
  });

  it('overlapping stores invalidate a remote reservation', async () => {
    const memory = createTestMemory(256n);
    await setReservation(memory, 1, addressAt(0), 8);
    await storeBytes({ memory, address: addressAt(4), source: new Uint8Array([1]), byteLength: 1 });
    assert.equal(slotValid(memory, 1), false);
    await setReservation(memory, 0, addressAt(32), 4);
    await withSharedLocks(memory.bytes, [reservationLockIndex(memory)], () =>
      invalidateOverlappingReservationsLocked(memory, addressAt(32), 4)
    );
    assert.equal(slotValid(memory, 0), false);
  });

  it('an unmapped conditional store consumes its reservation and releases the monitor', async () => {
    const memory = createTestMemory(256n);
    const address = addressAt(0x7fff_fff0);
    await setReservation(memory, 1, address, 4);
    assert.equal(
      await atomicStoreConditionalBytes({
        memory,
        address,
        source: new Uint8Array(8),
        byteLength: 4,
        hartId: 1,
      }),
      false
    );
    assert.equal(slotValid(memory, 1), false);
    await setReservation(memory, 1, addressAt(0), 4);
    assert.equal(slotValid(memory, 1), true);
  });

  it(
    'a remote worker releases the monitor and wakes a pending RAM store',
    { timeout: 3000 },
    async () => {
      const memory = createTestMemory(256n);
      const address = addressAt(0);
      await setReservation(memory, 1, address, 4);
      const worker = new Worker(
        `
      const { parentPort, workerData } = require('node:worker_threads');
      const lock = new Int32Array(workerData.buffer, workerData.index, 1);
      Atomics.store(lock, 0, 1);
      parentPort.postMessage('held');
      parentPort.once('message', () => {
        Atomics.store(lock, 0, 0);
        Atomics.notify(lock, 0, 1);
      });
    `,
        {
          eval: true,
          workerData: { buffer: memory.bytes.buffer, index: reservationLockIndex(memory) },
        }
      );
      try {
        await new Promise<void>((resolve, reject) => {
          worker.once('message', () => resolve());
          worker.once('error', reject);
        });
        const store = storeBytes({
          memory,
          address,
          source: new Uint8Array([0x77]),
          byteLength: 1,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(memory.bytes[0], 0);
        assert.equal(slotValid(memory, 1), true);
        worker.postMessage('release');
        await store;
        assert.equal(memory.bytes[0], 0x77);
        assert.equal(slotValid(memory, 1), false);
      } finally {
        await worker.terminate();
        const lock = new Int32Array(memory.bytes.buffer, reservationLockIndex(memory), 1);
        Atomics.store(lock, 0, 0);
        Atomics.notify(lock, 0);
      }
    }
  );

  it(
    'same-thread contention parks without blocking and resumes after notification',
    { timeout: 2000 },
    async () => {
      const memory = createTestMemory(256n);
      const lock = new Int32Array(memory.bytes.buffer, reservationLockIndex(memory), 1);
      Atomics.store(lock, 0, 1);
      let ran = false;
      try {
        const pending = withSharedLocks(memory.bytes, [reservationLockIndex(memory)], () => {
          ran = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(ran, false);
        Atomics.store(lock, 0, 0);
        assert.equal(Atomics.notify(lock, 0, 1), 1);
        await pending;
        assert.equal(ran, true);
        assert.equal(Atomics.load(lock, 0), 0);
      } finally {
        Atomics.store(lock, 0, 0);
        Atomics.notify(lock, 0);
      }
    }
  );
});
