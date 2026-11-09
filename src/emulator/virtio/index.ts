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

/** Virtio-mmio block device public API — guest window and init. */

import type { Memory } from '#emulator/memory';
import { VIRTIO_HOST_BYTE_LENGTH, virtioHostIndex } from '#emulator/virtio/layout';
import { storeVirtioDevicePresent } from '#emulator/virtio/registers';

/**
 * Zero the virtio host slab and set the device-present flag. Runs on the host before any
 * worker starts. `diskPresent` false leaves the window mapped but inert (probes read 0).
 *
 * Production always passes `false`: a real device only becomes visible once the disk
 * worker is fully ready, and its host flips the flag before startup resolves. The test fixture
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
  VIRTIO_REGION_ID,
} from '#emulator/virtio/layout';
export {
  loadBytesFromVirtio,
  storeBytesToVirtio,
  virtioMemoryLockIndexes,
} from '#emulator/virtio/memory';
export { initializeVirtio };
