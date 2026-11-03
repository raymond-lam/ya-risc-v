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
import {
  closeVirtioDiskImage,
  openVirtioDiskImage,
  readDiskImageBytes,
  writeDiskImageBytes,
} from '#emulator/virtio/disk';

const TEMP_PREFIX = 'ya-risc-v-virtio-';

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

describe('virtio disk image', () => {
  it("opens raw image read-write ('r+') and uses positional writes", async () => {
    const { dir, path } = writeTempImage(buildImage());
    const image = await openVirtioDiskImage(path);
    try {
      assert.equal(image.sizeBytes, 1280);
      assert.equal(
        await writeDiskImageBytes({ image, position: 0, source: new Uint8Array([0x5a, 0xa5]) }),
        2
      );
      const onDisk = readFileBytes(path);
      assert.deepEqual(onDisk.subarray(0, 2), new Uint8Array([0x5a, 0xa5]));
      assert.equal(onDisk[2], 0x5a);
      assert.equal(onDisk[512], 0xaa);
    } finally {
      await closeVirtioDiskImage(image);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads exact file bytes at positional offsets', async () => {
    const { dir, path } = writeTempImage(buildImage());
    const image = await openVirtioDiskImage(path);
    try {
      const atSector = new Uint8Array(8);
      assert.equal(await readDiskImageBytes({ image, position: 512, destination: atSector }), 8);
      assert.deepEqual(atSector, new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44]));

      const atZero = new Uint8Array(8);
      assert.equal(await readDiskImageBytes({ image, position: 0, destination: atZero }), 8);
      assert.deepEqual(atZero, new Uint8Array(8).fill(0x5a));
    } finally {
      await closeVirtioDiskImage(image);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('short-reads at EOF and returns the partial count', async () => {
    const { dir, path } = writeTempImage(buildImage());
    const image = await openVirtioDiskImage(path);
    try {
      const tail = new Uint8Array(8).fill(0xff);
      assert.equal(await readDiskImageBytes({ image, position: 1276, destination: tail }), 4);
      assert.deepEqual(tail.subarray(0, 4), new Uint8Array(4).fill(0x5a));

      const pastEnd = new Uint8Array(8);
      assert.equal(await readDiskImageBytes({ image, position: 1280, destination: pastEnd }), 0);
    } finally {
      await closeVirtioDiskImage(image);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects when the image path does not exist', async () => {
    const { dir } = writeTempImage(buildImage());
    try {
      await assert.rejects(openVirtioDiskImage(join(dir, 'missing.img')), { code: 'ENOENT' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps handles and capacities isolated between open image instances', async () => {
    const first = writeTempImage(buildImage());
    const second = writeTempImage(new Uint8Array(512).fill(0x11));
    const firstImage = await openVirtioDiskImage(first.path);
    const secondImage = await openVirtioDiskImage(second.path);
    try {
      assert.equal(firstImage.sizeBytes, 1280);
      assert.equal(secondImage.sizeBytes, 512);
      assert.equal(
        await writeDiskImageBytes({
          image: secondImage,
          position: 0,
          source: new Uint8Array([0x0f, 0xf0]),
        }),
        2
      );
      assert.deepEqual(readFileBytes(second.path).subarray(0, 2), new Uint8Array([0x0f, 0xf0]));
      assert.deepEqual(readFileBytes(first.path).subarray(0, 2), new Uint8Array([0x5a, 0x5a]));
      const firstBytes = new Uint8Array(2);
      assert.equal(
        await readDiskImageBytes({ image: firstImage, position: 0, destination: firstBytes }),
        2
      );
      assert.deepEqual(firstBytes, new Uint8Array([0x5a, 0x5a]));
    } finally {
      await closeVirtioDiskImage(firstImage);
      await closeVirtioDiskImage(secondImage);
      rmSync(first.dir, { recursive: true, force: true });
      rmSync(second.dir, { recursive: true, force: true });
    }
  });
});
