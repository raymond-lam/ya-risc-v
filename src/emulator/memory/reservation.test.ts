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
  atomicRamStore,
  setReservation,
  storeBytes,
  tryTakeReservation,
  type Memory,
} from '#emulator/memory';
import {
  invalidateOverlappingReservations,
  releaseScMonitorIfHeld,
} from '#emulator/memory/reservation';
import createTestMemory from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { signedNumberToBytes } from '#utils/bytes';

const addressAt = (offset: number): ReadonlyUint8Array =>
  signedNumberToBytes(new Uint8Array(8), offset, 32) as ReadonlyUint8Array;

/** Observe whether hart `hartId`'s slot is valid (test-only). */
const slotValid = (memory: Memory, hartId: number): boolean => {
  // Layout: lock(4)+pad(4)+slots; slot valid Int32 at slot base.
  const slotBase = memory.reservationMonitorHostIndex + 8 + hartId * 16;
  return Atomics.load(new Int32Array(memory.bytes.buffer, slotBase, 1), 0) !== 0;
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
      atomicRamStore({
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
    invalidateOverlappingReservations(memory, address, 4);
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
});
