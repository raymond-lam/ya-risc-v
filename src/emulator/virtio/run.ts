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
import { openVirtioDiskImage } from '#emulator/virtio/disk';
import type { VirtioDiskImage } from '#emulator/virtio/disk';
import {
  armVirtioDiskService,
  clearVirtioDiskCapacity,
  publishVirtioDiskReady,
  serviceVirtioDiskRequests,
} from '#emulator/virtio/service';
import type { VirtioDiskWorkerData } from '#emulator/virtio/types';

const main = async (): Promise<void> => {
  const { memory, diskImagePath } = workerData as VirtioDiskWorkerData;
  let diskImage: VirtioDiskImage;
  try {
    diskImage = await openVirtioDiskImage(diskImagePath); // 'r+'; rejects on a bad path
  } catch (error) {
    // Signal the failure so the worker host's ready-wait returns immediately; device-present
    // stays 0 and the guest probe reads an absent device (§FIX 1).
    publishVirtioDiskReady(memory, -1);
    throw error;
  }
  try {
    // Arm → capacity → readiness precedes the request loop, and the host only then presents
    // the device to the guest.
    const handled = armVirtioDiskService(memory, diskImage.size);
    await serviceVirtioDiskRequests(memory, diskImage, handled);
  } finally {
    clearVirtioDiskCapacity(memory);
    await diskImage.close(); // hygiene on any normal unwind
  }
};

if (parentPort !== null) {
  void main();
}
