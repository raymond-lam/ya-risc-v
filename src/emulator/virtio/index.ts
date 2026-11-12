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
 * Virtio-mmio block device public API — guest window, queue engine, disk device host,
 * and init.
 */

import type { Worker as NodeWorker, WorkerOptions } from 'node:worker_threads';
import type { Memory } from '#emulator/memory';
import Worker from '#emulator/Worker';
import { VIRTIO_HOST_BYTE_LENGTH, virtioHostIndex } from '#emulator/virtio/layout';
import { storeVirtioDevicePresent } from '#emulator/virtio/registers';
import type {
  VirtioDiskCreateOptions,
  VirtioDiskHandle,
  VirtioDiskWorkerData,
} from '#emulator/virtio/types';

const STARTUP_TIMEOUT_MS = 5_000;

/* eslint-disable no-restricted-syntax -- Worker host needs a constructor */
class VirtioDisk extends Worker implements VirtioDiskHandle {
  #exited = false;

  readonly #options: VirtioDiskCreateOptions;

  constructor(options: VirtioDiskCreateOptions) {
    super('Virtio disk', new URL(import.meta.resolve('#emulator/virtio/run')), STARTUP_TIMEOUT_MS);
    this.#options = options;
  }

  protected createWorkerOptions = (): Pick<WorkerOptions, 'workerData' | 'transferList'> => {
    const workerData = {
      memory: this.#options.memory,
      diskImagePath: this.#options.diskImagePath,
    } satisfies VirtioDiskWorkerData;
    return { workerData };
  };

  protected override onReady = (): void => {
    storeVirtioDevicePresent(this.#options.memory, true);
  };
  protected override onExit = (): void => {
    this.#exited = true;
    storeVirtioDevicePresent(this.#options.memory, false);
  };
  protected override stopWorker(worker: NodeWorker): void {
    if (this.#exited) return;
    const timer = setTimeout(() => super.stopWorker(worker), 1000);
    timer.unref();
    worker.once('exit', () => clearTimeout(timer));
    worker.postMessage('stop');
  }
}

/** Create the disk device host: a Promise-like awaitable handle with `start` / `stop`. */
const createVirtioDisk = (options: VirtioDiskCreateOptions): VirtioDiskHandle =>
  new VirtioDisk(options);

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
export { createVirtioDisk };
export type { VirtioDiskHandle } from '#emulator/virtio/types';
