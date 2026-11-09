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
import { loadBytes, type Memory } from '#emulator/memory';
import { initializeVirtio, loadBytesFromVirtio } from '#emulator/virtio';
import {
  VIRTIO_HOST_WAKE_SEQ,
  VIRTIO_HOST_DISK_CAPACITY_READY,
  VIRTIO_HOST_DISK_CAPACITY_LOW,
  VIRTIO_HOST_DISK_CAPACITY_HIGH,
  virtioHostInt32,
} from '#emulator/virtio/layout';
import {
  loadVirtioShadowU32,
  loadVirtioDevicePresent,
  loadVirtioDiskCapacity,
  storeVirtioDevicePresent,
} from '#emulator/virtio/registers';
import { armVirtioDiskService, clearVirtioDiskCapacity } from '#emulator/virtio/service';
import type { ReadonlyUint8Array } from '#types';
import { bytesToNumber, unsignedBigIntToBytes } from '#utils/bytes';
import createTestMemory from '#test/guest-memory';

const VIRTIO_BASE = 0x1000_1000n;

const virtioAddress = (offset: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), VIRTIO_BASE + offset) as ReadonlyUint8Array;

const readVirtioRegister = async (memory: Memory, offset: bigint): Promise<number> => {
  const destination = new Uint8Array(4);
  await loadBytes({ destination, memory, address: virtioAddress(offset), byteLength: 4 });
  return bytesToNumber(destination);
};

describe('virtio disk service startup', () => {
  it('arms the wake sequence and publishes capacity, leaving appearance to the host', async () => {
    const memory = createTestMemory(64n);
    initializeVirtio(memory, false);
    Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_WAKE_SEQ), 0, 7);

    const handled = armVirtioDiskService(memory, 1280n);

    assert.equal(handled, 7);
    assert.equal(Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_WAKE_SEQ), 0), 7);
    assert.equal(loadVirtioDiskCapacity(memory), 1280n);
    assert.equal(loadVirtioDevicePresent(memory), 0);
    assert.equal(await readVirtioRegister(memory, 0x000n), 0);
    assert.equal(await readVirtioRegister(memory, 0x0fcn), 0);

    // The host publishes device-present only after observing readiness.
    storeVirtioDevicePresent(memory, true);
    assert.equal(loadVirtioDevicePresent(memory), 1);
    assert.equal(await readVirtioRegister(memory, 0x000n), 0x7472_6976);
    assert.equal(await readVirtioRegister(memory, 0x0fcn), 1);
    assert.equal(await readVirtioRegister(memory, 0x100n), 2);

    clearVirtioDiskCapacity(memory);
    assert.equal(loadVirtioDiskCapacity(memory), 0n);
  });
  it('withdraws exposed capacity without mutating a large capacity snapshot', async () => {
    const memory = createTestMemory(64n);
    const imageSize = 0x1234_5678_9abc_de00n;
    armVirtioDiskService(memory, imageSize);
    const expected = unsignedBigIntToBytes(new Uint8Array(8), imageSize / 512n);
    const capacity = new Uint8Array(8);
    await loadBytes({
      destination: capacity,
      memory,
      address: virtioAddress(0x100n),
      byteLength: 8,
    });
    assert.deepEqual(capacity, expected);

    // Withdraw after the first byte of one guest access. Remaining bytes must come
    // from the same readiness-gated snapshot, not from new per-byte readiness checks.
    const destination = new Proxy(capacity, {
      set: (target, property, value: unknown): boolean => {
        const stored = Reflect.set(target, property, value);
        if (property === '0') clearVirtioDiskCapacity(memory);
        return stored;
      },
    });
    loadBytesFromVirtio({
      destination,
      memory,
      address: virtioAddress(0x100n),
      offset: 0x100n,
      byteLength: 8,
    });
    assert.deepEqual(capacity, expected);
    assert.equal(Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_DISK_CAPACITY_READY), 0), 0);
    assert.equal(loadVirtioDiskCapacity(memory), 0n);
    assert.equal(loadVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_LOW), 0x9abc_de00);
    assert.equal(loadVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH), 0x1234_5678);
    await loadBytes({
      destination: capacity,
      memory,
      address: virtioAddress(0x100n),
      byteLength: 8,
    });
    assert.deepEqual(capacity, new Uint8Array(8));
    clearVirtioDiskCapacity(memory); // withdrawal is idempotent, shadows remain intact
    assert.equal(loadVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH), 0x1234_5678);
  });
});
