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

import { Worker } from 'node:worker_threads';
import type { Memory } from '#emulator/memory';
import workerExecArgv from '#utils/worker-exec-argv';
import {
  VIRTIO_HOST_BYTE_LENGTH,
  VIRTIO_HOST_DISK_READY,
  storeVirtioDevicePresent,
  virtioHostIndex,
  virtioHostInt32,
} from '#emulator/virtio/layout';
import type {
  VirtioDiskCreateOptions,
  VirtioDiskHandle,
  VirtioDiskWorkerData,
} from '#emulator/virtio/types';

/* eslint-disable no-restricted-syntax -- Promise wrapper needs a constructor and promise methods */
class VirtioDisk implements VirtioDiskHandle {
  readonly [Symbol.toStringTag] = 'Promise';

  readonly #lifetime = Promise.withResolvers<void>();

  readonly #options: VirtioDiskCreateOptions;

  #worker: Worker | undefined;

  #started = false;

  #stopped = false;

  constructor(options: VirtioDiskCreateOptions) {
    this.#options = options;
  }

  start = (): void => {
    if (this.#stopped) {
      throw new Error('Already stopped.');
    }
    if (this.#started) {
      throw new Error('Already started.');
    }
    const workerData = {
      memory: this.#options.memory,
      diskImagePath: this.#options.diskImagePath,
    } satisfies VirtioDiskWorkerData;
    // Assign worker before marking started so a constructor throw leaves state untouched.
    const worker = new Worker(new URL(import.meta.resolve('#emulator/virtio/run')), {
      execArgv: workerExecArgv(),
      workerData,
    });
    this.#worker = worker;
    this.#started = true;
    worker.once('error', (error) => {
      this.#lifetime.reject(error);
    });
    worker.once('exit', (code) => {
      if (this.#stopped || code === 0) {
        this.#lifetime.resolve();
        return;
      }
      this.#lifetime.reject(new Error(`Virtio disk worker exited with code ${code}`));
    });
  };

  stop = (): void => {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    if (this.#worker !== undefined) {
      void this.#worker.terminate();
      return;
    }
    // Never started (or start failed before worker assignment): unblock awaiters.
    this.#lifetime.resolve();
  };

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): Promise<TResult1 | TResult2> {
    return this.#lifetime.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined
  ): Promise<void | TResult> {
    return this.#lifetime.promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): Promise<void> {
    return this.#lifetime.promise.finally(onfinally);
  }
}

/** Create the disk device host: a Promise-like awaitable handle with `start` / `stop`. */
const createVirtioDisk = (options: VirtioDiskCreateOptions): VirtioDiskHandle =>
  new VirtioDisk(options);

/**
 * Wait (bounded) for the disk worker's readiness level, then flip device-present on success.
 * A timeout or failed open (`-1`) leaves the device absent, so guest probes read an absent
 * device (§FIX 1).
 */
const presentVirtioDiskDevice = (memory: Memory, timeoutMs: number): void => {
  const ready = virtioHostInt32(memory, VIRTIO_HOST_DISK_READY);
  Atomics.wait(ready, 0, 0, timeoutMs);
  if (Atomics.load(ready, 0) === 1) {
    storeVirtioDevicePresent(memory, true);
  }
};

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
export { createVirtioDisk, presentVirtioDiskDevice };
export type { VirtioDiskHandle } from '#emulator/virtio/types';
