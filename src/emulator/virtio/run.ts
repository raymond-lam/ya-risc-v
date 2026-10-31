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

import { parentPort, workerData } from 'node:worker_threads';
import { waitWake } from '#emulator/wake';
import type { VirtioWorkerData } from '#emulator/virtio/types';
import { VIRTIO_HOST_OFFSET, virtioHostIndex } from '#emulator/virtio/region';
import serviceAllPending from '#emulator/virtio/queue';
import { bytesToInt32Array } from '#utils/bytes';

const main = async (): Promise<void> => {
  const { memory, image } = workerData as VirtioWorkerData;

  const kickIndex = virtioHostIndex(memory, VIRTIO_HOST_OFFSET.kick);
  const kick = bytesToInt32Array(memory.bytes, kickIndex);
  let seen = 0;

  for (;;) {
    // Snapshot the kick level before servicing: the CPU worker starts before this
    // one, so a kick may already be published. Snapshotting first and servicing
    // afterwards drains that kick; waiting first would park on a level that never
    // changes again and strand the queued descriptor.
    seen = Atomics.load(kick, 0);
    serviceAllPending(memory, image);
    await waitWake({ bytes: memory.bytes, index: kickIndex, fromLevel: seen });
  }
};

if (parentPort !== null) {
  void main();
}
