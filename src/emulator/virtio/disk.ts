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

/**
 * Worker-side virtio disk storage — opens the raw image 'r+' once per disk worker,
 * publishes its capacity into the host slab, performs positional synchronous file I/O
 * through the staging window, and services CPU-submitted requests on a wake word.
 * The image is never loaded into memory; files ≥ 2^53 bytes are out of scope (JS offsets).
 */

import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import type { Memory } from '#emulator/memory';
import { publishWakeLevel, waitWake } from '#emulator/wake';
import { bigIntAsNumber } from '#utils/int';
import {
  VIRTIO_HOST_COMPLETION_SEQ,
  VIRTIO_HOST_DISK_CAPACITY_HIGH,
  VIRTIO_HOST_DISK_CAPACITY_LOW,
  VIRTIO_HOST_DISK_CAPACITY_READY,
  VIRTIO_HOST_REQUEST_DIRECTION,
  VIRTIO_HOST_REQUEST_IO_ERROR,
  VIRTIO_HOST_REQUEST_LENGTH,
  VIRTIO_HOST_REQUEST_SECTOR_HIGH,
  VIRTIO_HOST_REQUEST_SECTOR_LOW,
  VIRTIO_HOST_REQUEST_SEQ,
  VIRTIO_HOST_STAGING,
  virtioHostIndex,
  virtioHostInt32,
  loadVirtioShadowU32,
  storeVirtioShadowU32,
} from '#emulator/virtio/layout';

let diskFd: number | null = null;

const openVirtioImage = (memory: Memory, path: string): void => {
  if (diskFd !== null) {
    closeSync(diskFd);
    diskFd = null;
  }
  diskFd = openSync(path, 'r+');
  const { size } = fstatSync(diskFd);
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_LOW, size >>> 0);
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH, Math.floor(size / 2 ** 32));
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_DISK_CAPACITY_READY), 0, 1);
};

const closeVirtioImage = (memory: Memory): void => {
  if (diskFd !== null) {
    closeSync(diskFd);
    diskFd = null;
  }
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_DISK_CAPACITY_READY), 0, 0);
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_LOW, 0);
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH, 0);
};

const readDiskSectors = (position: number, buffer: Uint8Array): number => {
  if (diskFd === null) {
    throw new Error('No virtio disk image is open.');
  }
  let total = 0;
  while (total < buffer.length) {
    const count = readSync(diskFd, buffer, total, buffer.length - total, position + total);
    if (count <= 0) {
      break;
    }
    total += count;
  }
  return total;
};

const writeDiskSectors = (position: number, buffer: Uint8Array): number => {
  if (diskFd === null) {
    throw new Error('No virtio disk image is open.');
  }
  let total = 0;
  while (total < buffer.length) {
    const count = writeSync(diskFd, buffer, total, buffer.length - total, position + total);
    if (count <= 0) {
      break;
    }
    total += count;
  }
  return total;
};

/** Serve exactly one CPU-submitted request, then publish its completion level. */
const serveVirtioDiskRequest = (memory: Memory): void => {
  const direction = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_DIRECTION), 0) >>> 0;
  const length = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_LENGTH), 0) >>> 0;
  const sectorLow = loadVirtioShadowU32(memory, VIRTIO_HOST_REQUEST_SECTOR_LOW);
  const sectorHigh = loadVirtioShadowU32(memory, VIRTIO_HOST_REQUEST_SECTOR_HIGH);
  const position = bigIntAsNumber((BigInt(sectorHigh) << 32n) | BigInt(sectorLow));
  const stagingBase = virtioHostIndex(memory, VIRTIO_HOST_STAGING);
  const staging = memory.bytes.subarray(stagingBase, stagingBase + length);
  let ioError = 0;
  try {
    if (direction === 0) {
      if (readDiskSectors(position, staging) !== length) {
        ioError = 1;
      }
    } else if (writeDiskSectors(position, staging) !== length) {
      ioError = 1;
    }
  } catch {
    ioError = 1;
  }
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_IO_ERROR), 0, ioError);
  const completion = virtioHostInt32(memory, VIRTIO_HOST_COMPLETION_SEQ);
  publishWakeLevel({
    bytes: memory.bytes,
    index: virtioHostIndex(memory, VIRTIO_HOST_COMPLETION_SEQ),
    level: (Atomics.load(completion, 0) >>> 0) + 1,
  });
};

/** Runs until the host terminates the worker: serve submitted requests on the wake word. */
const serviceVirtioDiskRequests = async (memory: Memory): Promise<void> => {
  const requestIndex = virtioHostIndex(memory, VIRTIO_HOST_REQUEST_SEQ);
  let handled = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0) >>> 0;
  for (;;) {
    let submitted = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0) >>> 0;
    while (handled !== submitted) {
      serveVirtioDiskRequest(memory);
      handled = (handled + 1) >>> 0;
      submitted = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0) >>> 0;
    }
    await waitWake({ bytes: memory.bytes, index: requestIndex, fromLevel: submitted });
  }
};

export {
  closeVirtioImage,
  openVirtioImage,
  readDiskSectors,
  serviceVirtioDiskRequests,
  writeDiskSectors,
};
