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
 * Virtio-mmio block device public API — guest window, queue engine, and host init.
 * (The disk worker host lives at the public-exception subpath `#emulator/virtio/host`.)
 */

import type { Memory } from '#emulator/memory';
import {
  VIRTIO_HOST_BYTE_LENGTH,
  storeVirtioDevicePresent,
  virtioHostIndex,
} from '#emulator/virtio/layout';

/**
 * Zero the virtio host slab and set the device-present flag. Runs on the host before any
 * worker starts. `diskPresent` false leaves the window mapped but inert (probes read 0).
 *
 * Production always passes `false`: a real device only becomes visible once the disk
 * worker is fully ready, and the worker host flips the flag (§FIX 1). The test fixture
 * passes `true` to present a ready device without spawning a worker.
 */
const initializeVirtio = (memory: Memory, diskPresent: boolean): void => {
  const base = virtioHostIndex(memory, 0);
  memory.bytes.fill(0, base, base + Number(VIRTIO_HOST_BYTE_LENGTH));
  storeVirtioDevicePresent(memory, diskPresent);
};

export {
  VIRTIO_GUEST_BYTE_LENGTH,
  VIRTIO_HOST_BYTE_LENGTH,
  VIRTIO_QUEUE_NUM_MAX,
  VIRTIO_REGION_ID,
} from '#emulator/virtio/layout';
export { loadVirtioDiskCapacity } from '#emulator/virtio/layout';
export { loadBytesFromVirtio, storeBytesToVirtio } from '#emulator/virtio/memory';
export {
  loadVirtioDiskCompletionSeq,
  serviceVirtioDiskQueue,
  waitVirtioDiskCompletion,
} from '#emulator/virtio/queue';
export { initializeVirtio };
