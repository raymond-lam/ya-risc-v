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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadBytes, type Memory } from '#emulator/memory';
import {
  closeVirtioImage,
  openVirtioImage,
  readDiskSectors,
  writeDiskSectors,
} from '#emulator/virtio/disk';
import { loadVirtioDiskCapacity } from '#emulator/virtio/layout';
import type { ReadonlyUint8Array } from '#types';
import { bytesToBigInt, unsignedBigIntToBytes } from '#utils/bytes';
import createTestMemory from '#test/guest-memory';

const VIRTIO_BASE = 0x1000_1000n;
const TEMP_PREFIX = 'ya-risc-v-virtio-';

const virtioAddress = (offset: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), VIRTIO_BASE + offset) as ReadonlyUint8Array;

/** Read the 8-byte capacity config field through the guest window. */
const readCapacitySectors = (memory: Memory): bigint => {
  const destination = new Uint8Array(8);
  loadBytes({ destination, memory, address: virtioAddress(0x100n), byteLength: 8 });
  return bytesToBigInt(destination);
};

const buildImage = (): Uint8Array => {
  const image = new Uint8Array(1280).fill(0x5a);
  image.set(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44]), 512);
  return image;
};

/** File contents as a plain Uint8Array (readFileSync returns a Buffer). */
const readFileBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

const writeTempImage = (bytes: Uint8Array): { dir: string; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const path = join(dir, 'disk.img');
  writeFileSync(path, bytes);
  return { dir, path };
};

describe('virtio disk', () => {
  it("openVirtioImage binds a raw file read-write ('r+') and publishes capacity", () => {
    const { dir, path } = writeTempImage(buildImage());
    const memory = createTestMemory(64n);
    try {
      openVirtioImage(memory, path);
      assert.equal(loadVirtioDiskCapacity(memory), 1280n);
      assert.equal(readCapacitySectors(memory), 2n);

      assert.equal(writeDiskSectors(0, new Uint8Array([0x5a, 0xa5])), 2);
      const onDisk = readFileBytes(path);
      assert.deepEqual(onDisk.subarray(0, 2), new Uint8Array([0x5a, 0xa5]));
      assert.equal(onDisk[2], 0x5a);
      assert.equal(onDisk[512], 0xaa);

      closeVirtioImage(memory);
      assert.equal(loadVirtioDiskCapacity(memory), 0n);
    } finally {
      closeVirtioImage(memory);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readDiskSectors returns exact file bytes', () => {
    const { dir, path } = writeTempImage(buildImage());
    const memory = createTestMemory(64n);
    try {
      openVirtioImage(memory, path);
      const atSector = new Uint8Array(8);
      assert.equal(readDiskSectors(512, atSector), 8);
      assert.deepEqual(atSector, new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44]));

      const atZero = new Uint8Array(8);
      assert.equal(readDiskSectors(0, atZero), 8);
      assert.deepEqual(atZero, new Uint8Array(8).fill(0x5a));
    } finally {
      closeVirtioImage(memory);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readDiskSectors short-reads at EOF and returns the partial count', () => {
    const { dir, path } = writeTempImage(buildImage());
    const memory = createTestMemory(64n);
    try {
      openVirtioImage(memory, path);
      const tail = new Uint8Array(8).fill(0xff);
      assert.equal(readDiskSectors(1276, tail), 4);
      assert.deepEqual(tail.subarray(0, 4), new Uint8Array(4).fill(0x5a));

      const pastEnd = new Uint8Array(8);
      assert.equal(readDiskSectors(1280, pastEnd), 0);
    } finally {
      closeVirtioImage(memory);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('openVirtioImage throws on a missing path', () => {
    const { dir } = writeTempImage(buildImage());
    const memory = createTestMemory(64n);
    try {
      assert.throws(() => openVirtioImage(memory, join(dir, 'missing.img')), { code: 'ENOENT' });
      assert.equal(loadVirtioDiskCapacity(memory), 0n);
    } finally {
      closeVirtioImage(memory);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-opening closes the previous image', () => {
    const first = writeTempImage(buildImage());
    const second = writeTempImage(new Uint8Array(512).fill(0x11));
    const memory = createTestMemory(64n);
    try {
      openVirtioImage(memory, first.path);
      assert.equal(loadVirtioDiskCapacity(memory), 1280n);
      openVirtioImage(memory, second.path);
      assert.equal(loadVirtioDiskCapacity(memory), 512n);

      assert.equal(writeDiskSectors(0, new Uint8Array([0x0f, 0xf0])), 2);
      assert.deepEqual(readFileBytes(second.path).subarray(0, 2), new Uint8Array([0x0f, 0xf0]));
      assert.deepEqual(readFileBytes(first.path).subarray(0, 2), new Uint8Array([0x5a, 0x5a]));
    } finally {
      closeVirtioImage(memory);
      rmSync(first.dir, { recursive: true, force: true });
      rmSync(second.dir, { recursive: true, force: true });
    }
  });
});
