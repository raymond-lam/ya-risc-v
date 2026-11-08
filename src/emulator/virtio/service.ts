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

/** Worker-owned virtio queue service and startup capacity publication. */

import type { Memory } from '#emulator/memory';
import { bigIntAsNumber } from '#utils/int';
import { waitWake } from '#emulator/wake';
import { reservationLockIndex } from '#emulator/reservation';
import withSharedLocks from '#emulator/with-shared-locks';
import { virtioMemoryLockIndexes } from '#emulator/virtio/memory';
import {
  claimVirtioRequest,
  completeVirtioRequest,
  type VirtioQueueState,
} from '#emulator/virtio/queue';
import type { DiskImage } from '#emulator/virtio/disk';
import { readDiskImageBytes, writeDiskImageBytes } from '#emulator/virtio/disk';
import {
  VIRTIO_HOST_QUEUE_EPOCH,
  VIRTIO_HOST_QUEUE_NOTIFIED,
  VIRTIO_HOST_KICK_SEQ,
  VIRTIO_HOST_CONFIG_GENERATION,
  VIRTIO_HOST_DISK_CAPACITY_HIGH,
  VIRTIO_HOST_DISK_CAPACITY_LOW,
  VIRTIO_HOST_DISK_CAPACITY_READY,
  virtioHostIndex,
  virtioHostInt32,
  loadVirtioShadowU32,
  storeVirtioShadowU32,
} from '#emulator/virtio/layout';

/** Publish the open image's capacity words and advance the config generation. */
const publishVirtioDiskCapacity = (memory: Memory, imageSize: bigint): void => {
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_LOW, Number(imageSize & 0xffff_ffffn));
  storeVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH, Number(imageSize >> 32n));
  // The 0 → N capacity transition advances the guest-visible config generation.
  const generation = loadVirtioShadowU32(memory, VIRTIO_HOST_CONFIG_GENERATION);
  storeVirtioShadowU32(memory, VIRTIO_HOST_CONFIG_GENERATION, generation + 1);
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_DISK_CAPACITY_READY), 0, 1);
};

/** Withdraw readiness before closing the image; keep capacity shadows immutable so a
 * reader that already observed readiness can finish reading the intact old capacity. */
const clearVirtioDiskCapacity = (memory: Memory): void => {
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_DISK_CAPACITY_READY), 0, 0);
};

/** Arm once before the host exposes the device. Re-arming or reusing a live machine SAB
 * after withdrawal is unsupported; capacity shadows stay immutable until SAB disposal. */
const armVirtioDiskService = (memory: Memory, imageSize: bigint): number => {
  publishVirtioDiskCapacity(memory, imageSize);
  return Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_KICK_SEQ), 0) >>> 0;
};

const serviceVirtioDiskRequests = async (
  memory: Memory,
  diskImage: DiskImage,
  handledSequence: number,
  signal?: AbortSignal
): Promise<void> => {
  const state: VirtioQueueState = { epoch: -1, lastAvail: 0, kicked: false };
  const locks = [reservationLockIndex(memory), ...virtioMemoryLockIndexes(memory)];
  let handled = handledSequence;
  while (!signal?.aborted) {
    const claimed: { request: ReturnType<typeof claimVirtioRequest> } = { request: null };
    let advanced = false;
    await withSharedLocks(memory.bytes, locks, () => {
      if (signal?.aborted) return;
      // Reconcile epoch before applying this kick (including the first post-ready kick).
      const epoch = loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_EPOCH);
      if (state.epoch !== epoch) {
        state.epoch = epoch;
        state.lastAvail = 0;
        state.kicked = false;
      }
      const kick = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_KICK_SEQ), 0) >>> 0;
      handled = kick;
      // Control wakes (reset/deactivation) are not queue notifications. Both MMIO
      // publication and this consume/clear hold the control lock, so no kick is lost.
      if (loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_NOTIFIED) !== 0) {
        state.kicked = true;
        storeVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_NOTIFIED, 0);
      }
      const previous = state.lastAvail;
      claimed.request = claimVirtioRequest(memory, state);
      advanced = state.lastAvail !== previous;
    });
    if (claimed.request !== null) {
      const current = claimed.request;
      let ioError = false;
      const { plan } = current;
      try {
        if (plan.kind !== 'sync') {
          const position = bigIntAsNumber(plan.sectorOffset);
          const length =
            plan.kind === 'read'
              ? await readDiskImageBytes({ image: diskImage, position, destination: current.data })
              : await writeDiskImageBytes({ image: diskImage, position, source: current.data });
          ioError = length !== current.data.length;
        }
      } catch {
        ioError = true;
      }
      await withSharedLocks(memory.bytes, locks, () => {
        if (!signal?.aborted) completeVirtioRequest(memory, current, ioError);
      });
    } else if (!advanced && !signal?.aborted) {
      await waitWake({
        bytes: memory.bytes,
        index: virtioHostIndex(memory, VIRTIO_HOST_KICK_SEQ),
        fromLevel: handled,
        signal,
      });
    }
  }
};
export { armVirtioDiskService, clearVirtioDiskCapacity, serviceVirtioDiskRequests };
