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

import { dmaLoad, dmaStore, resolveDmaSpan } from '#emulator/dma';
import { setReservationLocked, tryTakeReservation, withMonitorLock } from '#emulator/reservation';
import createTestMemory from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes } from '#utils/bytes';

const guestAddress = (value: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), value) as ReadonlyUint8Array;

describe('DMA seam', () => {
  it('loads and stores only complete spans inside guest RAM', () => {
    const memory = createTestMemory(256n);
    const address = guestAddress(32n);
    const source = Uint8Array.of(1, 2, 3, 4);

    assert.deepEqual(resolveDmaSpan(memory, address, 4), { offset: 32n });
    assert.equal(dmaStore(memory, address, source.length, source), true);

    const destination = new Uint8Array(4);
    assert.equal(dmaLoad(memory, address, destination.length, destination), true);
    assert.deepEqual(destination, source);
  });

  it('rejects unmapped, straddling, and MMIO spans', () => {
    const memory = createTestMemory(256n);

    assert.equal(resolveDmaSpan(memory, guestAddress(0x8000_0000n), 4), null);
    assert.equal(resolveDmaSpan(memory, guestAddress(254n), 4), null);
    assert.equal(resolveDmaSpan(memory, guestAddress(0x1000_0000n), 4), null);
    assert.equal(dmaLoad(memory, guestAddress(254n), 4, new Uint8Array(4)), false);
    assert.equal(dmaStore(memory, guestAddress(254n), 4, new Uint8Array(4)), false);
  });

  it('invalidates an overlapping LR/SC reservation', () => {
    const memory = createTestMemory(256n);
    const address = guestAddress(0n);
    withMonitorLock(memory, () => {
      setReservationLocked(memory, 1, address, 8);
    });

    assert.equal(dmaStore(memory, address, 4, new Uint8Array(4)), true);
    assert.equal(tryTakeReservation(memory, 1, address, 8), false);
  });
});
