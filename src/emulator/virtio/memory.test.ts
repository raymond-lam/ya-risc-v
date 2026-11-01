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
import { closeVirtioImage, openVirtioImage } from '#emulator/virtio/disk';
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
    writeVirtioRegister(memory, 0x038n, 8);
    writeVirtioRegister(memory, 0x030n, 0);
    assert.equal(readVirtioRegister(memory, 0x038n), 0);
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

  it('config capacity is floor(fileSize / 512) sectors, 0 until published, 0 when absent', () => {
    const memory = createTestMemory(64n);
    assert.equal(readCapacity(memory), 0n);

    const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    const path = join(dir, 'disk.img');
    writeFileSync(path, new Uint8Array(1280));
    try {
      openVirtioImage(memory, path);
      assert.equal(readCapacity(memory), 2n);
      closeVirtioImage(memory);
      assert.equal(readCapacity(memory), 0n);
    } finally {
      closeVirtioImage(memory);
      rmSync(dir, { recursive: true, force: true });
    }

    initializeVirtio(memory, false);
    assert.equal(readCapacity(memory), 0n);
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
