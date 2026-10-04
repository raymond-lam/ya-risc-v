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
import { atomicStoreBytes, storeBytes, type Memory } from '#emulator/memory';
import {
  invalidateOverlappingReservationsLocked,
  releaseScMonitorIfHeld,
  RESERVATION_REGION_ID,
  setReservationLocked,
  tryTakeReservation,
  withMonitorLock,
} from '#emulator/reservation';
import { bigIntAsNumber } from '#utils/int';
import createTestMemory from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { signedNumberToBytes } from '#utils/bytes';

const addressAt = (offset: number): ReadonlyUint8Array =>
  signedNumberToBytes(new Uint8Array(8), offset, 32) as ReadonlyUint8Array;

/** Arm a reservation under the monitor lock (mirrors production LR path). */
const setReservation = (
  memory: Memory,
  hartId: number,
  address: ReadonlyUint8Array,
  byteLength: number
): void => {
  withMonitorLock(memory, () => {
    setReservationLocked(memory, hartId, address, byteLength);
  });
};

/** Observe whether hart `hartId`'s slot is valid (test-only). */
const slotValid = (memory: Memory, hartId: number): boolean => {
  // Layout: lock(4)+pad(4)+slots; slot valid Int32 at slot base.
  const region = memory.regions.get(RESERVATION_REGION_ID);
  assert.ok(region);
  const slotBase = bigIntAsNumber(region.hostIndex) + 8 + hartId * 16;
  return Atomics.load(new Int32Array(memory.bytes.buffer, slotBase, 1), 0) !== 0;
};

/** Absolute host index of the reservation monitor Int32 lock. */
const reservationLockIndex = (memory: Memory): number => {
  const region = memory.regions.get(RESERVATION_REGION_ID);
  assert.ok(region);
  return bigIntAsNumber(region.hostIndex);
};

describe('reservation monitor', () => {
  it('setReservation on the same line clears the other hart slot', () => {
    const memory = createTestMemory(256n);
    const address = addressAt(0);
    setReservation(memory, 0, address, 8);
    assert.equal(slotValid(memory, 0), true);
    setReservation(memory, 1, addressAt(8), 8); // same 64-byte line
    assert.equal(slotValid(memory, 0), false);
    assert.equal(slotValid(memory, 1), true);
  });

  it('tryTake keeps the reservation held until the SC store releases it', () => {
    const memory = createTestMemory(256n);
    const address = addressAt(16);
    setReservation(memory, 0, address, 8);
    assert.equal(tryTakeReservation(memory, 0, address, 8), true);
    assert.equal(slotValid(memory, 0), true);
    assert.equal(
      atomicStoreBytes({
        memory,
        address,
        source: signedNumberToBytes(new Uint8Array(8), 0x55, 32),
        byteLength: 8,
      }),
      true
    );
    assert.equal(slotValid(memory, 0), false);
  });

  it('tryTake failure clears a mismatched reservation', () => {
    const memory = createTestMemory(256n);
    setReservation(memory, 0, addressAt(0), 8);
    assert.equal(tryTakeReservation(memory, 0, addressAt(64), 8), false);
    assert.equal(slotValid(memory, 0), false);
  });

  it('overlapping store from another hart waits for an in-flight SC then invalidates', () => {
    const memory = createTestMemory(256n);
    const address = addressAt(32);
    setReservation(memory, 0, address, 4);
    assert.equal(tryTakeReservation(memory, 0, address, 4), true);
    // Hart 1 cannot steal the line while the SC lock is held — sequential same-thread
    // nest would incorrectly share the lock, so release first then invalidate as a
    // post-SC observer would after the store window.
    releaseScMonitorIfHeld(memory);
    withMonitorLock(memory, () => {
      invalidateOverlappingReservationsLocked(memory, address, 4);
    });
    assert.equal(slotValid(memory, 0), false);
  });

  it('storeBytes invalidates an overlapping reservation for a remote hart', () => {
    const memory = createTestMemory(256n);
    setReservation(memory, 1, addressAt(0), 8);
    storeBytes({
      memory,
      address: addressAt(4),
      source: new Uint8Array([1]),
      byteLength: 1,
    });
    assert.equal(slotValid(memory, 1), false);
  });

  it('two harts cannot both take a reservation on the same line', () => {
    const memory = createTestMemory(256n);
    const address = addressAt(0);
    setReservation(memory, 0, address, 8);
    setReservation(memory, 1, address, 8);
    assert.equal(slotValid(memory, 0), false);
    assert.equal(tryTakeReservation(memory, 0, address, 8), false);
    assert.equal(tryTakeReservation(memory, 1, address, 8), true);
    releaseScMonitorIfHeld(memory);
  });

  it('storeBytes holds the monitor across invalidate and the RAM write', () => {
    const memory = createTestMemory(256n);
    const address = addressAt(8);
    setReservation(memory, 0, address, 4);
    // Nested acquire (same worker) proves storeBytes takes the monitor for the
    // whole critical section; the remote slot is cleared before we return.
    withMonitorLock(memory, () => {
      storeBytes({
        memory,
        address,
        source: new Uint8Array([0xab, 0xcd, 0xef, 0x01]),
        byteLength: 4,
      });
      assert.equal(slotValid(memory, 0), false);
      assert.equal(memory.bytes[8], 0xab);
    });
  });

  it('atomicStoreBytes releases an SC-held monitor even when the store is unmapped', () => {
    const memory = createTestMemory(256n);
    const address = addressAt(0);
    setReservation(memory, 0, address, 4);
    assert.equal(tryTakeReservation(memory, 0, address, 4), true);
    const unmapped = signedNumberToBytes(new Uint8Array(8), 0x7fff_fff0, 32) as ReadonlyUint8Array;
    assert.equal(
      atomicStoreBytes({
        memory,
        address: unmapped,
        source: new Uint8Array(8),
        byteLength: 4,
      }),
      false
    );
    // Lock must be free for another hart to arm a reservation.
    setReservation(memory, 1, address, 4);
    assert.equal(slotValid(memory, 1), true);
  });

  it('a remote worker blocks on the monitor until the SC window releases', async () => {
    const memory = createTestMemory(256n);
    const address = addressAt(48);
    setReservation(memory, 0, address, 4);
    assert.equal(tryTakeReservation(memory, 0, address, 4), true);

    const lockIndex = reservationLockIndex(memory);
    const sab = memory.bytes.buffer;
    assert.ok(sab instanceof SharedArrayBuffer);

    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const lock = new Int32Array(workerData.sab, workerData.lockIndex, 1);
      parentPort.postMessage('started');
      // Block until the main thread releases the SC-held lock (value becomes 0).
      Atomics.wait(lock, 0, 1);
      parentPort.postMessage(Atomics.load(lock, 0));
      `,
      { eval: true, workerData: { sab, lockIndex } }
    );

    await new Promise<void>((resolve, reject) => {
      worker.once('message', (message) => {
        if (message === 'started') {
          resolve();
          return;
        }
        reject(new Error(`unexpected worker message: ${String(message)}`));
      });
      worker.once('error', reject);
    });

    // Worker is waiting on lock==1. Completing the SC store must notify it.
    assert.equal(
      atomicStoreBytes({
        memory,
        address,
        source: signedNumberToBytes(new Uint8Array(8), 0x44, 32),
        byteLength: 4,
      }),
      true
    );

    const observed = await new Promise<number>((resolve, reject) => {
      worker.once('message', (message) => {
        resolve(message as number);
      });
      worker.once('error', reject);
      setTimeout(() => reject(new Error('worker did not observe lock release')), 2000);
    });
    assert.equal(observed, 0);
    await worker.terminate();
    assert.equal(slotValid(memory, 0), false);
  });
});
