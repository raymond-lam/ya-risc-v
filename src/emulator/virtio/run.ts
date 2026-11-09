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
import { closeDiskImage, openDiskImage } from '#emulator/virtio/disk';
import {
  clearVirtioDiskCapacity,
  publishVirtioDiskCapacity,
  runVirtioDiskDevice,
} from '#emulator/virtio/device';
import { VIRTIO_HOST_WAKE_SEQ, virtioHostInt32 } from '#emulator/virtio/layout';
import type { VirtioDiskWorkerData } from '#emulator/virtio/types';

const main = async (): Promise<void> => {
  const { memory, diskImagePath } = workerData as VirtioDiskWorkerData;
  const stop = new AbortController();
  parentPort?.on('message', (message: unknown) => {
    if (message === 'stop') stop.abort();
  });
  const diskImage = await openDiskImage(diskImagePath); // 'r+'; rejects on a bad path
  try {
    // Publish capacity and take the wake baseline before reporting readiness; the host
    // then presents the device.
    publishVirtioDiskCapacity(memory, diskImage.sizeBytes);
    const handled = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_WAKE_SEQ), 0) >>> 0;
    parentPort?.postMessage('ready');
    await runVirtioDiskDevice(memory, diskImage, handled, stop.signal);
  } finally {
    clearVirtioDiskCapacity(memory);
    await closeDiskImage(diskImage);
    parentPort?.close();
  }
};

if (parentPort !== null) {
  void main();
}
