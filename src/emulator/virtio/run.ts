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
import {
  closeVirtioImage,
  openVirtioImage,
  serviceVirtioDiskRequests,
} from '#emulator/virtio/disk';
import type { VirtioDiskWorkerData } from '#emulator/virtio/types';

const main = async (): Promise<void> => {
  const { memory, diskImagePath } = workerData as VirtioDiskWorkerData;
  try {
    openVirtioImage(memory, diskImagePath); // 'r+'; throws on a bad path
    await serviceVirtioDiskRequests(memory); // runs until the host terminates us
  } finally {
    closeVirtioImage(memory); // hygiene on any normal unwind
  }
};

if (parentPort !== null) {
  void main();
}
