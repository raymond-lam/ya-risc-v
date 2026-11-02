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
 * performs positional asynchronous file I/O through the staging window, and services
 * CPU-submitted requests on a wake word. Transfers are awaited one at a time, so the
 * worker never has more than one request in flight and the publish contract below is
 * unchanged by the asynchrony.
 *
 * Startup ordering (§FIX 1: atomic device appearance) is single-threaded here and MUST be
 * preserved: (a) the service loop arms `handled := current requestSeq` while the device is
 * still absent, (b) the capacity words are published (and the config generation advances),
 * (c) readiness is signalled to the worker host, which only then flips the guest-visible
 * device-present flag. Reordering any of these re-opens the startup race where a guest
 * request is silently absorbed or IOERR'd before the device is coherent.
 *
 * The image is never loaded into memory; files ≥ 2^53 bytes are out of scope (JS offsets).
 */

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Memory } from '#emulator/memory';
import { publishWakeLevel, waitWake } from '#emulator/wake';
import { bigIntAsNumber } from '#utils/int';
import {
  VIRTIO_HOST_COMPLETION_SEQ,
  VIRTIO_HOST_CONFIG_GENERATION,
  VIRTIO_HOST_DISK_CAPACITY_HIGH,
  VIRTIO_HOST_DISK_CAPACITY_LOW,
  VIRTIO_HOST_DISK_CAPACITY_READY,
  VIRTIO_HOST_DISK_READY,
  VIRTIO_HOST_REQUEST_DIRECTION,
  VIRTIO_HOST_REQUEST_IO_ERROR,
  VIRTIO_HOST_REQUEST_LENGTH,
  VIRTIO_HOST_REQUEST_SECTOR_HIGH,
  VIRTIO_HOST_REQUEST_SECTOR_LOW,
  VIRTIO_HOST_REQUEST_SEQ,
  VIRTIO_HOST_STAGING,
  VIRTIO_HOST_TEST_PAUSE,
  virtioHostIndex,
  virtioHostInt32,
  loadVirtioShadowU32,
  storeVirtioShadowU32,
} from '#emulator/virtio/layout';

let diskHandle: FileHandle | null = null;

/** Byte size of the currently-open image (0 while no image is open). */
let diskImageSize = 0;

const NO_IMAGE_OPEN = 'No virtio disk image is open.';

/** The open image handle; throws when no image is bound (callers must open first). */
const requireVirtioImage = (): FileHandle => {
  if (diskHandle === null) {
    throw new Error(NO_IMAGE_OPEN);
  }
  return diskHandle;
};

/** Open the raw image read-write and record its size. No slab writes: capacity is
 *  published separately (arm → capacity → ready) once the service loop is armed. */
const openVirtioImage = async (path: string): Promise<void> => {
  const previous = diskHandle;
  diskHandle = null;
  diskImageSize = 0;
  await previous?.close();
  const handle = await open(path, 'r+'); // ALWAYS 'r+' (constraint: no read-only mode)
  try {
    diskImageSize = (await handle.stat()).size;
  } catch (error) {
    await handle.close();
    throw error;
  }
  diskHandle = handle;
};

/** Publish the open image's capacity words and advance the config generation. */
const publishVirtioDiskCapacity = (memory: Memory): void => {
  requireVirtioImage();
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_LOW, diskImageSize >>> 0);
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH, Math.floor(diskImageSize / 2 ** 32));
  // §FIX 3: the 0 → N capacity transition advances the guest-visible config generation.
  // This iteration has exactly one transition (one image open); the counter would advance
  // again on any future config change.
  const generation = loadVirtioShadowU32(memory, VIRTIO_HOST_CONFIG_GENERATION);
  storeVirtioShadowU32(memory, VIRTIO_HOST_CONFIG_GENERATION, generation + 1);
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_DISK_CAPACITY_READY), 0, 1);
};

/** Unpublish capacity first (so no request is admitted mid-close), then close the image. */
const closeVirtioImage = async (memory: Memory): Promise<void> => {
  const handle = diskHandle;
  diskHandle = null;
  diskImageSize = 0;
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_DISK_CAPACITY_READY), 0, 0);
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_LOW, 0);
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH, 0);
  await handle?.close();
};

/** Publish the disk worker's readiness level (0 not ready, 1 ready, -1 open failed). */
const publishVirtioDiskReady = (memory: Memory, level: number): void => {
  publishWakeLevel({
    bytes: memory.bytes,
    index: virtioHostIndex(memory, VIRTIO_HOST_DISK_READY),
    level,
  });
};

/** Positional read into `buffer`, looping over short reads; returns the bytes read (short
 *  only at EOF). Positional I/O keeps the handle's file offset out of the picture. */
const readDiskSectors = async (position: number, buffer: Uint8Array): Promise<number> => {
  const handle = requireVirtioImage();
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total);
    if (bytesRead <= 0) {
      break;
    }
    total += bytesRead;
  }
  return total;
};

/** Positional write from `buffer`, looping over short writes; returns the bytes written. */
const writeDiskSectors = async (position: number, buffer: Uint8Array): Promise<number> => {
  const handle = requireVirtioImage();
  let total = 0;
  while (total < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      total,
      buffer.length - total,
      position + total
    );
    if (bytesWritten <= 0) {
      break;
    }
    total += bytesWritten;
  }
  return total;
};

/** Serve exactly one CPU-submitted request, then publish its completion level. The caller
 *  awaits it, so the transfer, the IOERR word, and the completion wake level are ordered. */
const serveVirtioDiskRequest = async (memory: Memory): Promise<void> => {
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
      if ((await readDiskSectors(position, staging)) !== length) {
        ioError = 1;
      }
    } else if ((await writeDiskSectors(position, staging)) !== length) {
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

/** Test-only freeze hook: block while the pause word is non-zero (production never sets it). */
const waitForTestPause = (memory: Memory): void => {
  const pause = virtioHostInt32(memory, VIRTIO_HOST_TEST_PAUSE);
  while (Atomics.load(pause, 0) !== 0) {
    Atomics.wait(pause, 0, 1);
  }
};

/**
 * Arm the service loop, publish capacity then readiness, then serve requests until the host
 * terminates the worker. Readiness is published as the last step before serving — the worker
 * host consumes it and only then flips the guest-visible device-present flag (§FIX 1).
 */
const serviceVirtioDiskRequests = async (memory: Memory): Promise<void> => {
  const requestIndex = virtioHostIndex(memory, VIRTIO_HOST_REQUEST_SEQ);
  // (a) Arm FIRST: handled := current requestSeq. The device is still absent
  //     (devicePresent == 0), so no guest request can exist yet — this is 0, and every
  //     request submitted once the device appears is served (nothing is absorbed).
  let handled = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0) >>> 0;
  // (b) Publish the capacity words (config generation advances 0 → 1).
  publishVirtioDiskCapacity(memory);
  // Test-only freeze between capacity publish and readiness (see §FIX 1).
  waitForTestPause(memory);
  // (c) Publish readiness; the worker host flips devicePresent to 1 only after this.
  publishVirtioDiskReady(memory, 1);
  for (;;) {
    let submitted = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0) >>> 0;
    while (handled !== submitted) {
      await serveVirtioDiskRequest(memory);
      handled = (handled + 1) >>> 0;
      submitted = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0) >>> 0;
    }
    await waitWake({ bytes: memory.bytes, index: requestIndex, fromLevel: submitted });
  }
};

export {
  closeVirtioImage,
  openVirtioImage,
  publishVirtioDiskCapacity,
  publishVirtioDiskReady,
  readDiskSectors,
  serviceVirtioDiskRequests,
  writeDiskSectors,
};
