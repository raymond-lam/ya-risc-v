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

/** Worker-side virtio block request channel and startup publication protocol. */

import type { Memory } from '#emulator/memory';
import { publishWakeLevel, waitWake } from '#emulator/wake';
import { bigIntAsNumber } from '#utils/int';
import type { VirtioDiskImage } from '#emulator/virtio/disk';
import { readDiskImageBytes, writeDiskImageBytes } from '#emulator/virtio/disk';
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
  virtioHostIndex,
  virtioHostInt32,
  loadVirtioShadowU32,
  storeVirtioShadowU32,
} from '#emulator/virtio/layout';

/** Publish the open image's capacity words and advance the config generation. */
const publishVirtioDiskCapacity = (memory: Memory, imageSize: number): void => {
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_LOW, imageSize >>> 0);
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH, Math.floor(imageSize / 2 ** 32));
  // The 0 → N capacity transition advances the guest-visible config generation.
  const generation = loadVirtioShadowU32(memory, VIRTIO_HOST_CONFIG_GENERATION);
  storeVirtioShadowU32(memory, VIRTIO_HOST_CONFIG_GENERATION, generation + 1);
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_DISK_CAPACITY_READY), 0, 1);
};

/** Withdraw published capacity before the worker closes its image. */
const clearVirtioDiskCapacity = (memory: Memory): void => {
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_DISK_CAPACITY_READY), 0, 0);
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_LOW, 0);
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH, 0);
};

/** Publish the disk worker's readiness level (0 not ready, 1 ready, -1 open failed). */
const publishVirtioDiskReady = (memory: Memory, level: number): void => {
  publishWakeLevel({
    bytes: memory.bytes,
    index: virtioHostIndex(memory, VIRTIO_HOST_DISK_READY),
    level,
  });
};

/** Arm first, then publish capacity and finally readiness; return the armed sequence. */
const armVirtioDiskService = (memory: Memory, imageSize: number): number => {
  // The device is absent until readiness has been published and consumed by the host.
  const handled = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0) >>> 0;
  publishVirtioDiskCapacity(memory, imageSize);
  publishVirtioDiskReady(memory, 1);
  return handled;
};

/** Serve exactly one CPU-submitted request, then publish its completion level. */
const serveVirtioDiskRequest = async (
  memory: Memory,
  diskImage: VirtioDiskImage
): Promise<void> => {
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
      if (
        (await readDiskImageBytes({ image: diskImage, position, destination: staging })) !== length
      ) {
        ioError = 1;
      }
    } else if (
      (await writeDiskImageBytes({ image: diskImage, position, source: staging })) !== length
    ) {
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

/** Service requests one at a time until the host terminates this worker. */
const serviceVirtioDiskRequests = async (
  memory: Memory,
  diskImage: VirtioDiskImage,
  handledSequence: number
): Promise<void> => {
  const requestIndex = virtioHostIndex(memory, VIRTIO_HOST_REQUEST_SEQ);
  let handled = handledSequence;
  for (;;) {
    let submitted = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0) >>> 0;
    while (handled !== submitted) {
      await serveVirtioDiskRequest(memory, diskImage);
      handled = (handled + 1) >>> 0;
      submitted = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0) >>> 0;
    }
    await waitWake({ bytes: memory.bytes, index: requestIndex, fromLevel: submitted });
  }
};

export {
  armVirtioDiskService,
  clearVirtioDiskCapacity,
  publishVirtioDiskReady,
  serviceVirtioDiskRequests,
};
