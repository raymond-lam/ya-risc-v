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

import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { describe, it } from 'node:test';
import { loadBytes, type Memory } from '#emulator/memory';
import { initializeVirtio } from '#emulator/virtio';
import {
  VIRTIO_HOST_COMPLETION_SEQ,
  VIRTIO_HOST_DISK_READY,
  VIRTIO_HOST_REQUEST_DIRECTION,
  VIRTIO_HOST_REQUEST_IO_ERROR,
  VIRTIO_HOST_REQUEST_LENGTH,
  VIRTIO_HOST_REQUEST_SEQ,
  loadVirtioDevicePresent,
  loadVirtioDiskCapacity,
  storeVirtioDevicePresent,
  virtioHostInt32,
} from '#emulator/virtio/layout';
import { armVirtioDiskService, clearVirtioDiskCapacity } from '#emulator/virtio/service';
import type { ReadonlyUint8Array } from '#types';
import { bytesToNumber, unsignedBigIntToBytes } from '#utils/bytes';
import createTestMemory from '#test/guest-memory';

const VIRTIO_BASE = 0x1000_1000n;

const virtioAddress = (offset: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), VIRTIO_BASE + offset) as ReadonlyUint8Array;

const readVirtioRegister = (memory: Memory, offset: bigint): number => {
  const destination = new Uint8Array(4);
  loadBytes({ destination, memory, address: virtioAddress(offset), byteLength: 4 });
  return bytesToNumber(destination);
};

const SERVICE_WORKER_SOURCE = `
  import { parentPort, workerData } from 'node:worker_threads';

  const pendingReads = new Map();
  let readCount = 0;
  parentPort.on('message', (message) => {
    if (message.type === 'checkpoint') {
      parentPort.postMessage({
        type: 'checkpoint',
        reads: readCount,
        completion: Atomics.load(workerData.completionWord, 0) >>> 0,
      });
    } else if (message.type === 'release') {
      const resolve = pendingReads.get(message.count);
      if (resolve !== undefined) {
        pendingReads.delete(message.count);
        resolve(message.result);
      }
    }
  });

  const diskImage = {
    read: (_position, buffer) => {
      const count = ++readCount;
      parentPort.postMessage({ type: 'read-started', count });
      return new Promise((resolve) => pendingReads.set(count, resolve));
    },
    write: async () => 0,
    close: async () => {},
  };
  const main = async () => {
    const { serviceVirtioDiskRequests } = await import(workerData.serviceUrl);
    parentPort.postMessage({ type: 'ready' });
    await serviceVirtioDiskRequests(workerData.memory, diskImage, 0);
  };
  void main().catch((error) => parentPort.postMessage({ type: 'service-error', error: String(error) }));
`;

const nextWorkerMessage = (worker: Worker): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      cleanup();
      resolve(message);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      worker.off('message', onMessage);
      worker.off('error', onError);
    };
    worker.once('message', onMessage);
    worker.once('error', onError);
  });

const waitForSequence = async (word: Int32Array, expected: number): Promise<void> => {
  while (Atomics.load(word, 0) >>> 0 !== expected) {
    const observed = Atomics.load(word, 0);
    const result = Atomics.waitAsync(word, 0, observed);
    if (result.async) {
      await result.value;
    }
  }
};

describe('virtio disk service startup', () => {
  it('arms the request sequence before capacity and readiness, leaving appearance to the host', () => {
    const memory = createTestMemory(64n);
    initializeVirtio(memory, false);
    Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0, 7);

    const handled = armVirtioDiskService(memory, 1280);

    assert.equal(handled, 7);
    assert.equal(Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0), 7);
    assert.equal(loadVirtioDiskCapacity(memory), 1280n);
    assert.equal(Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_DISK_READY), 0), 1);
    assert.equal(loadVirtioDevicePresent(memory), 0);
    assert.equal(readVirtioRegister(memory, 0x000n), 0);
    assert.equal(readVirtioRegister(memory, 0x0fcn), 0);

    // The host publishes device-present only after observing readiness.
    storeVirtioDevicePresent(memory, true);
    assert.equal(loadVirtioDevicePresent(memory), 1);
    assert.equal(readVirtioRegister(memory, 0x000n), 0x7472_6976);
    assert.equal(readVirtioRegister(memory, 0x0fcn), 1);
    assert.equal(readVirtioRegister(memory, 0x100n), 2);

    clearVirtioDiskCapacity(memory);
    assert.equal(loadVirtioDiskCapacity(memory), 0n);
  });
});

describe('virtio disk request service', () => {
  it(
    'awaits each image operation and publishes IOERR before completion for a short read',
    { timeout: 5_000 },
    async (t) => {
      const memory = createTestMemory(64n);
      const completionWord = virtioHostInt32(memory, VIRTIO_HOST_COMPLETION_SEQ);
      const worker = new Worker(SERVICE_WORKER_SOURCE, {
        eval: true,
        ...{ type: 'module' },
        execArgv: ['--import', 'tsx', '--conditions', '@ya-risc-v/source'],
        workerData: {
          memory,
          completionWord,
          serviceUrl: new URL('./service.ts', import.meta.url).href,
        },
      });
      t.after(async () => {
        await worker.terminate();
      });

      assert.deepEqual(await nextWorkerMessage(worker), { type: 'ready' });

      const submitRequest = (sequence: number): void => {
        Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_DIRECTION), 0, 0);
        Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_LENGTH), 0, 4);
        const requestWord = virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ);
        Atomics.store(requestWord, 0, sequence);
        Atomics.notify(requestWord, 0);
      };

      submitRequest(1);
      assert.deepEqual(await nextWorkerMessage(worker), { type: 'read-started', count: 1 });

      // Queue a second request while the first disk read is still unresolved. The worker
      // checkpoint runs after the request submission; an un-awaited first read would already
      // have entered the second read before this message could be handled.
      submitRequest(2);
      worker.postMessage({ type: 'checkpoint' });
      assert.deepEqual(await nextWorkerMessage(worker), {
        type: 'checkpoint',
        reads: 1,
        completion: 0,
      });

      worker.postMessage({ type: 'release', count: 1, result: 0 });
      assert.deepEqual(await nextWorkerMessage(worker), { type: 'read-started', count: 2 });
      await waitForSequence(completionWord, 1);
      assert.equal(Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_IO_ERROR), 0), 1);

      worker.postMessage({ type: 'release', count: 2, result: 4 });
      await waitForSequence(completionWord, 2);
      assert.equal(Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_IO_ERROR), 0), 0);
    }
  );
});
