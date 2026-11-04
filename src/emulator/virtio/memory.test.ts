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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadBytes, storeBytes, type Memory } from '#emulator/memory';
import { initializeVirtio } from '#emulator/virtio';
import { openDiskImage } from '#emulator/virtio/disk';
import { closeDiskImage } from '#emulator/virtio/disk';
import { armVirtioDiskService, clearVirtioDiskCapacity } from '#emulator/virtio/service';
import type { ReadonlyUint8Array } from '#types';
import {
  bytesToBigInt,
  bytesToNumber,
  unsignedBigIntToBytes,
  unsignedNumberToBytes,
} from '#utils/bytes';
import createTestMemory from '#test/guest-memory';

const VIRTIO_BASE = 0x1000_1000n;
const TEMP_PREFIX = 'ya-risc-v-virtio-';

const virtioAddress = (offset: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), VIRTIO_BASE + offset) as ReadonlyUint8Array;

const readVirtioRegister = (memory: Memory, offset: bigint): number => {
  const destination = new Uint8Array(4);
  loadBytes({ destination, memory, address: virtioAddress(offset), byteLength: 4 });
  return bytesToNumber(destination);
};

const writeVirtioRegister = (memory: Memory, offset: bigint, value: number): void => {
  storeBytes({
    memory,
    address: virtioAddress(offset),
    source: unsignedNumberToBytes(new Uint8Array(8), value),
    byteLength: 4,
  });
};

const readCapacity = (memory: Memory): bigint => {
  const destination = new Uint8Array(8);
  loadBytes({ destination, memory, address: virtioAddress(0x100n), byteLength: 8 });
  return bytesToBigInt(destination);
};

describe('virtio guest window', () => {
  it('identity registers read the exact probe values', () => {
    const memory = createTestMemory(64n);
    assert.equal(readVirtioRegister(memory, 0x000n), 0x7472_6976);
    assert.equal(readVirtioRegister(memory, 0x004n), 2);
    assert.equal(readVirtioRegister(memory, 0x008n), 2);
    assert.equal(readVirtioRegister(memory, 0x00cn), 0x554d_4551);
    writeVirtioRegister(memory, 0x000n, 0xffff_ffff);
    assert.equal(readVirtioRegister(memory, 0x000n), 0x7472_6976);
  });

  it('holes read 0 and ignore stores', () => {
    const memory = createTestMemory(64n);
    assert.equal(readVirtioRegister(memory, 0x018n), 0);
    writeVirtioRegister(memory, 0x018n, 0xffff_ffff);
    assert.equal(readVirtioRegister(memory, 0x018n), 0);
    assert.equal(readVirtioRegister(memory, 0x108n), 0);
    writeVirtioRegister(memory, 0x108n, 0xffff_ffff);
    assert.equal(readVirtioRegister(memory, 0x108n), 0);
  });

  it('DeviceFeatures selects the VERSION_1 high word', () => {
    const memory = createTestMemory(64n);
    assert.equal(readVirtioRegister(memory, 0x010n), 0x0000_0000);
    writeVirtioRegister(memory, 0x014n, 1);
    assert.equal(readVirtioRegister(memory, 0x010n), 0x0000_0001);
    writeVirtioRegister(memory, 0x014n, 2);
    assert.equal(readVirtioRegister(memory, 0x010n), 0);
  });

  it('xv6 status protocol stores and reads back verbatim', () => {
    const memory = createTestMemory(64n);
    writeVirtioRegister(memory, 0x070n, 0);
    assert.equal(readVirtioRegister(memory, 0x070n), 0);
    writeVirtioRegister(memory, 0x070n, 1);
    assert.equal(readVirtioRegister(memory, 0x070n), 1);
    writeVirtioRegister(memory, 0x070n, 3);
    assert.equal(readVirtioRegister(memory, 0x070n), 3);
    writeVirtioRegister(memory, 0x070n, 0xb);
    assert.equal(readVirtioRegister(memory, 0x070n), 0xb);
    writeVirtioRegister(memory, 0x070n, 0xf);
    assert.equal(readVirtioRegister(memory, 0x070n), 0xf);
  });

  it('writing Status without ACKNOWLEDGE resets the queue configuration', () => {
    const memory = createTestMemory(64n);
    writeVirtioRegister(memory, 0x030n, 0); // QueueSel 0
    writeVirtioRegister(memory, 0x038n, 8); // QueueNum
    writeVirtioRegister(memory, 0x044n, 1); // QueueReady
    writeVirtioRegister(memory, 0x080n, 0x1234);
    writeVirtioRegister(memory, 0x084n, 0x5678);
    writeVirtioRegister(memory, 0x090n, 0x9abc);
    writeVirtioRegister(memory, 0x094n, 0xdef0);
    writeVirtioRegister(memory, 0x0a0n, 0x1111);
    writeVirtioRegister(memory, 0x0a4n, 0x2222);

    writeVirtioRegister(memory, 0x070n, 0);
    assert.equal(readVirtioRegister(memory, 0x038n), 0);
    assert.equal(readVirtioRegister(memory, 0x044n), 0);
    assert.equal(readVirtioRegister(memory, 0x000n), 0x7472_6976);
  });

  it('queue register WARL and queueSel gating', () => {
    const memory = createTestMemory(64n);
    writeVirtioRegister(memory, 0x030n, 0); // QueueSel 0
    writeVirtioRegister(memory, 0x038n, 3); // invalid queue size
    assert.equal(readVirtioRegister(memory, 0x038n), 0);
    writeVirtioRegister(memory, 0x038n, 8);
    assert.equal(readVirtioRegister(memory, 0x038n), 8);
    writeVirtioRegister(memory, 0x038n, 16);
    assert.equal(readVirtioRegister(memory, 0x038n), 8);

    writeVirtioRegister(memory, 0x030n, 1); // QueueSel 1
    assert.equal(readVirtioRegister(memory, 0x034n), 0);
    assert.equal(readVirtioRegister(memory, 0x038n), 0);
    assert.equal(readVirtioRegister(memory, 0x044n), 0);
    writeVirtioRegister(memory, 0x038n, 8); // gated: queue 0's shadow is untouched
    writeVirtioRegister(memory, 0x030n, 0);
    // Queue 0's QueueNum persists across QueueSel changes (per-queue register);
    // the write above was gated, so the value stored under QueueSel 0 (8) stands.
    assert.equal(readVirtioRegister(memory, 0x038n), 8);
    assert.equal(readVirtioRegister(memory, 0x034n), 8);
  });

  it('W-only registers read 0', () => {
    const memory = createTestMemory(64n);
    const writable: readonly bigint[] = [
      0x014n,
      0x020n,
      0x024n,
      0x030n,
      0x080n,
      0x084n,
      0x090n,
      0x094n,
      0x0a0n,
      0x0a4n,
      0x050n,
      0x064n,
    ];
    for (const offset of writable) {
      writeVirtioRegister(memory, offset, 0xffff_ffff);
      assert.equal(readVirtioRegister(memory, offset), 0);
    }
  });

  it('config capacity is floor(fileSize / 512) sectors, 0 until published, 0 when absent', async () => {
    const memory = createTestMemory(64n);
    assert.equal(readCapacity(memory), 0n);

    const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    const path = join(dir, 'disk.img');
    writeFileSync(path, new Uint8Array(1280));
    const diskImage = await openDiskImage(path);
    try {
      armVirtioDiskService(memory, diskImage.sizeBytes);
      assert.equal(readCapacity(memory), 2n);
      clearVirtioDiskCapacity(memory);
      assert.equal(readCapacity(memory), 0n);
    } finally {
      await closeDiskImage(diskImage);
      rmSync(dir, { recursive: true, force: true });
    }

    initializeVirtio(memory, false);
    assert.equal(readCapacity(memory), 0n);
  });

  it('config generation reads 0 while absent and ≥1 once capacity publishes (§FIX 3)', async () => {
    const memory = createTestMemory(64n);
    assert.equal(readVirtioRegister(memory, 0x0fcn), 0);

    const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    const path = join(dir, 'disk.img');
    writeFileSync(path, new Uint8Array(1280));
    const diskImage = await openDiskImage(path);
    try {
      // Capacity is published by the service, not by opening the file (generation is 0).
      assert.equal(readVirtioRegister(memory, 0x0fcn), 0);
      armVirtioDiskService(memory, diskImage.sizeBytes);
      const generation = readVirtioRegister(memory, 0x0fcn);
      assert.ok(generation >= 1);
      // Stable across reads while the config is unchanged.
      assert.equal(readVirtioRegister(memory, 0x0fcn), generation);
      assert.equal(readVirtioRegister(memory, 0x0fcn), generation);
    } finally {
      clearVirtioDiskCapacity(memory);
      await closeDiskImage(diskImage);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FEATURES_OK is validated against unadvertised feature bits (§FIX 4)', () => {
    const negotiate = (
      memory: Memory,
      driverFeaturesHi: number,
      driverFeaturesLo: number
    ): number => {
      writeVirtioRegister(memory, 0x024n, 1); // DriverFeaturesSel = 1 (high word)
      writeVirtioRegister(memory, 0x020n, driverFeaturesHi);
      writeVirtioRegister(memory, 0x024n, 0); // DriverFeaturesSel = 0 (low word)
      writeVirtioRegister(memory, 0x020n, driverFeaturesLo);
      writeVirtioRegister(memory, 0x070n, 0xb); // ACK | DRIVER | FEATURES_OK
      return readVirtioRegister(memory, 0x070n);
    };

    // Accepting VERSION_1 (bit 32 = high word bit 0) is valid → FEATURES_OK preserved.
    const withVersion1 = createTestMemory(64n);
    assert.equal(negotiate(withVersion1, 0x1, 0x0) & 0x8, 0x8);

    // xv6 negotiates driver features 0 and must still reach DRIVER_OK (QEMU leniency).
    const xv6 = createTestMemory(64n);
    assert.equal(negotiate(xv6, 0x0, 0x0) & 0x8, 0x8);

    // A bogus unadvertised bit (bit 33) is rejected: FEATURES_OK silently cleared.
    const bogus = createTestMemory(64n);
    assert.equal(negotiate(bogus, 0x2, 0x0) & 0x8, 0x0);
  });

  it('absent device: every register reads 0 and stores are ignored', () => {
    const memory = createTestMemory(64n);
    initializeVirtio(memory, false);
    for (const offset of [0x000n, 0x004n, 0x008n, 0x00cn]) {
      assert.equal(readVirtioRegister(memory, offset), 0);
    }
    writeVirtioRegister(memory, 0x070n, 0xf);
    writeVirtioRegister(memory, 0x038n, 8);
    writeVirtioRegister(memory, 0x044n, 1);
    writeVirtioRegister(memory, 0x050n, 0);
    assert.equal(readVirtioRegister(memory, 0x070n), 0);
    assert.equal(readVirtioRegister(memory, 0x038n), 0);
    assert.equal(readVirtioRegister(memory, 0x044n), 0);
  });
});
