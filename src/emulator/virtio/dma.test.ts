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
import { loadBytes, storeBytes, type Memory } from '#emulator/memory';
import { RAM_REGION_ID } from '#emulator/ram';
import {
  RESERVATION_REGION_ID,
  setReservationLocked,
  withMonitorLock,
} from '#emulator/reservation';
import { loadGuestRamBytes, storeGuestRamBytes } from '#emulator/virtio/dma';
import { bigIntAsNumber } from '#utils/int';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes } from '#utils/bytes';
import createTestMemory from '#test/guest-memory';

const guest = (offset: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), offset) as ReadonlyUint8Array;

const VIRTIO_BASE = 0x1000_1000n;

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
  const region = memory.regions.get(RESERVATION_REGION_ID);
  assert.ok(region);
  const slotBase = bigIntAsNumber(region.hostIndex) + 8 + hartId * 16;
  return Atomics.load(new Int32Array(memory.bytes.buffer, slotBase, 1), 0) !== 0;
};

describe('virtio dma', () => {
  it('loadGuestRamBytes returns exact RAM bytes and true', () => {
    const memory = createTestMemory(256n);
    const ram = memory.regions.get(RAM_REGION_ID);
    assert.ok(ram);
    memory.bytes.set(new Uint8Array([0x11, 0x22, 0x33, 0x44]), bigIntAsNumber(ram.hostIndex) + 4);
    const destination = new Uint8Array(4).fill(0xaa);
    const ok = loadGuestRamBytes({ destination, memory, address: guest(4n), byteLength: 4 });
    assert.equal(ok, true);
    assert.deepEqual(destination, new Uint8Array([0x11, 0x22, 0x33, 0x44]));
  });

  it('loadGuestRamBytes rejects out-of-window and straddling ranges, leaving the destination untouched', () => {
    const memory = createTestMemory(256n);
    const pastEnd = new Uint8Array(4).fill(0xaa);
    assert.equal(
      loadGuestRamBytes({ destination: pastEnd, memory, address: guest(0x100n), byteLength: 4 }),
      false
    );
    assert.deepEqual(pastEnd, new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa]));

    const straddling = new Uint8Array(8).fill(0xaa);
    assert.equal(
      loadGuestRamBytes({ destination: straddling, memory, address: guest(0xfcn), byteLength: 8 }),
      false
    );
    assert.deepEqual(straddling, new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]));
  });

  it('storeGuestRamBytes writes exactly and returns true', () => {
    const memory = createTestMemory(256n);
    const ok = storeGuestRamBytes({
      memory,
      address: guest(8n),
      source: new Uint8Array([0xde, 0xad]),
      byteLength: 2,
    });
    assert.equal(ok, true);
    const readback = new Uint8Array(2);
    loadBytes({ destination: readback, memory, address: guest(8n), byteLength: 2 });
    assert.deepEqual(readback, new Uint8Array([0xde, 0xad]));
  });

  it('storeGuestRamBytes invalidates an overlapping reservation', () => {
    const memory = createTestMemory(256n);
    setReservation(memory, 0, guest(0n), 8);
    assert.equal(slotValid(memory, 0), true);
    const ok = storeGuestRamBytes({
      memory,
      address: guest(0x10n),
      source: new Uint8Array([0x01]),
      byteLength: 1,
    });
    assert.equal(ok, true);
    assert.equal(slotValid(memory, 0), false);
  });

  it('storeGuestRamBytes rejects non-RAM targets without touching RAM', () => {
    const memory = createTestMemory(256n);
    storeBytes({ memory, address: guest(0n), source: new Uint8Array([0x5a]), byteLength: 1 });
    assert.equal(
      storeGuestRamBytes({
        memory,
        address: guest(VIRTIO_BASE),
        source: new Uint8Array([0x99]),
        byteLength: 1,
      }),
      false
    );
    assert.equal(
      storeGuestRamBytes({
        memory,
        address: guest(0x800n),
        source: new Uint8Array([0x99]),
        byteLength: 1,
      }),
      false
    );
    const canary = new Uint8Array(1);
    loadBytes({ destination: canary, memory, address: guest(0n), byteLength: 1 });
    assert.deepEqual(canary, new Uint8Array([0x5a]));
  });
});
