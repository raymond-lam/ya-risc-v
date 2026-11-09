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
import { PassThrough, Readable } from 'node:stream';
import { describe, it, type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import SharedWorker from '#emulator/Worker';
import type { Memory } from '#emulator/memory';
import { create } from '#emulator';
import { create as createCpu } from '#emulator/cpu';
import { create as createTimer } from '#emulator/timer';
import { create as createTerminal } from '#emulator/terminal';
import createTestMemory from '#test/guest-memory';
import { CLINT_GUEST_BYTE_LENGTH, CLINT_REGION_ID } from '#emulator/clint';
import { PLIC_GUEST_BYTE_LENGTH, PLIC_REGION_ID } from '#emulator/plic';
import { RAM_REGION_ID } from '#emulator/ram';
import { SYSCON_GUEST_BYTE_LENGTH, SYSCON_REGION_ID } from '#emulator/syscon';
import { UART_GUEST_BYTE_LENGTH, UART_REGION_ID } from '#emulator/uart';
import { VIRTIO_GUEST_BYTE_LENGTH, VIRTIO_REGION_ID } from '#emulator/virtio';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes } from '#utils/bytes';

const TEST_STARTUP_TIMEOUT_MS = 12_000;

/* eslint-disable no-restricted-syntax -- Test subclass configures the shared Worker constructor */
class StartupTimeoutWorker extends SharedWorker {
  readonly #memory: Memory;

  constructor(memory: Memory) {
    super(
      'Startup timeout test',
      new URL(import.meta.resolve('#emulator/timer/run')),
      TEST_STARTUP_TIMEOUT_MS
    );
    this.#memory = memory;
  }

  protected createWorkerOptions = () => ({ workerData: { memory: this.#memory } });
}
/* eslint-enable no-restricted-syntax */

const guest = (address: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), address) as ReadonlyUint8Array;

const window = (
  address: bigint,
  guestByteLength: bigint
): { guestAddress: ReadonlyUint8Array; guestByteLength: bigint } => ({
  guestAddress: guest(address),
  guestByteLength,
});

/** Explicit virt-like windows passed into `create` (the emulator has no defaults). */
const virtRegions = (
  ramByteLength: bigint,
  ramBase: bigint = 0x8000_0000n
): Map<string, { guestAddress: ReadonlyUint8Array; guestByteLength: bigint }> =>
  new Map([
    [RAM_REGION_ID, window(ramBase, ramByteLength)],
    [UART_REGION_ID, window(0x1000_0000n, UART_GUEST_BYTE_LENGTH)],
    [CLINT_REGION_ID, window(0x0200_0000n, CLINT_GUEST_BYTE_LENGTH)],
    [PLIC_REGION_ID, window(0x0c00_0000n, PLIC_GUEST_BYTE_LENGTH)],
    [SYSCON_REGION_ID, window(0x0010_0000n, SYSCON_GUEST_BYTE_LENGTH)],
    [VIRTIO_REGION_ID, window(0x1000_1000n, VIRTIO_GUEST_BYTE_LENGTH)],
  ]);

describe('emulator create', () => {
  it('rejects an image that does not fit in the ram region', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    assert.throws(
      () =>
        create({
          image: new Uint8Array(16),
          stdin,
          stdout,
          guestRegions: virtRegions(8n),
          timebaseHz: 10_000_000n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x8000_0000n),
        }),
      { name: 'RangeError', message: /does not fit in ram region/ }
    );
  });

  it('rejects a reset PC outside the ram region', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    assert.throws(
      () =>
        create({
          image: new Uint8Array(0),
          stdin,
          stdout,
          guestRegions: virtRegions(16n),
          timebaseHz: 10_000_000n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x1000n),
        }),
      { name: 'RangeError', message: /reset PC is outside the ram region/ }
    );
  });

  it('rejects a timebase frequency outside 1 through 2^32-1', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    assert.throws(
      () =>
        create({
          image: new Uint8Array(0),
          stdin,
          stdout,
          guestRegions: virtRegions(16n),
          timebaseHz: 0n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x8000_0000n),
        }),
      { name: 'RangeError', message: /timebase frequency/ }
    );
  });

  it('start then stop joins without leaving workers hanging', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    // Single `wfi` encoding; hart advances PC then waits until host stop terminates it.
    const image = new Uint8Array([0x73, 0x00, 0x50, 0x10]);
    const emulator = create({
      image,
      stdin,
      stdout,
      guestRegions: virtRegions(4096n, 0x9000_0000n),
      timebaseHz: 10_000_000n,
      deviceTreeAddress: 'end',
      resetPc: guest(0x9000_0000n),
    });
    let joined = false;
    void emulator.then(() => {
      joined = true;
    });
    assert.equal(await emulator.start(), undefined);
    assert.equal(joined, false, 'startup must not await the emulator lifetime');
    await emulator.stop();
    await emulator;
    assert.equal(joined, true);
  });

  it(
    'stop waits for emulator startup and joins every child started by it',
    { timeout: 5_000 },
    async () => {
      const emulator = create({
        image: new Uint8Array([0x73, 0x00, 0x50, 0x10]),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        guestRegions: virtRegions(4096n),
        timebaseHz: 10_000_000n,
        deviceTreeAddress: 'end',
        resetPc: guest(0x8000_0000n),
      });
      try {
        const startup = emulator.start();
        assert.throws(() => emulator.start(), /Already started/);
        const shutdown = emulator.stop();
        assert.equal(emulator.stop(), shutdown);
        assert.throws(() => emulator.start(), /Already stopped/);
        await startup;
        await shutdown;
        await emulator;
      } finally {
        await emulator.stop();
      }
    }
  );

  it(
    'joins partial startup rollback and preserves a synchronous startup failure',
    { timeout: 5_000 },
    async (context) => {
      const error = new Error('stream conversion failed');
      context.mock.method(Readable, 'toWeb', () => {
        throw error;
      });
      const emulator = create({
        image: new Uint8Array([0x73, 0x00, 0x50, 0x10]),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        guestRegions: virtRegions(4096n),
        timebaseHz: 10_000_000n,
        deviceTreeAddress: 'end',
        resetPc: guest(0x8000_0000n),
      });
      try {
        const startup = emulator.start();
        const shutdown = emulator.stop();
        await assert.rejects(startup, (reason: unknown) => reason === error);
        await assert.rejects(shutdown, (reason: unknown) => reason === error);
        await assert.rejects(emulator, (reason: unknown) => reason === error);
        assert.throws(() => emulator.start(), /Already stopped/);
        assert.equal(emulator.stop(), shutdown);
      } finally {
        await emulator.stop().catch(() => {});
      }
    }
  );

  it('stop before start is idempotent and unblocks await', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const image = new Uint8Array([0x73, 0x00, 0x50, 0x10]);
    const emulator = create({
      image,
      stdin,
      stdout,
      guestRegions: virtRegions(4096n),
      timebaseHz: 10_000_000n,
      deviceTreeAddress: 'end',
      resetPc: guest(0x8000_0000n),
    });
    await emulator.stop();
    await emulator.stop();
    await emulator;
    assert.throws(
      () => {
        void emulator.start();
      },
      { message: 'Already stopped.' }
    );
  });

  it(
    'worker handles await startup before immediate stop and cannot restart',
    { timeout: 5_000 },
    async () => {
      for (const startFirst of [false, true]) {
        const memory = createTestMemory(256n);
        const handles = [
          createCpu({ memory, resetPc: guest(0x8000_0000n), deviceTreeAddress: null }),
          createTimer({ memory }),
          createTerminal({ memory, stdin: new PassThrough(), stdout: new PassThrough() }),
        ];
        for (const handle of handles) {
          const startup = startFirst ? handle.start() : null;
          if (startFirst) {
            assert.throws(() => handle.start(), /Already started/);
          }
          const shutdown = handle.stop();
          assert.equal(handle.stop(), shutdown);
          if (startup !== null) {
            await startup;
          }
          await shutdown;
          await handle;
          assert.throws(() => handle.start(), /Already stopped/);
        }
      }
    }
  );

  it('rejects a guest region map that omits a required id', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const regions = virtRegions(16n);
    regions.delete(CLINT_REGION_ID);
    assert.throws(
      () =>
        create({
          image: new Uint8Array(0),
          stdin,
          stdout,
          guestRegions: regions,
          timebaseHz: 10_000_000n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x8000_0000n),
        }),
      { name: 'RangeError', message: "Missing guest region 'clint'." }
    );
  });

  it('rejects a guest region map whose windows overlap', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const regions = virtRegions(16n);
    // Move the UART window on top of the RAM window: `createMemory` must reject it.
    regions.set(UART_REGION_ID, window(0x8000_0000n, UART_GUEST_BYTE_LENGTH));
    assert.throws(
      () =>
        create({
          image: new Uint8Array(0),
          stdin,
          stdout,
          guestRegions: regions,
          timebaseHz: 10_000_000n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x8000_0000n),
        }),
      { name: 'RangeError', message: 'ram window overlaps uart.' }
    );
  });

  it('rejects an unknown guest region id', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const regions = virtRegions(16n);
    regions.set('disk', window(0x4000_0000n, 16n));
    assert.throws(
      () =>
        create({
          image: new Uint8Array(0),
          stdin,
          stdout,
          guestRegions: regions,
          timebaseHz: 10_000_000n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x8000_0000n),
        }),
      { name: 'RangeError', message: "Unknown guest region 'disk'." }
    );
  });
});

// Observe real worker construction without replacing its methods or its worker entry.
const observeStartup = (
  context: TestContext,
  createHandle: (memory: Memory) => ReturnType<typeof createCpu>
) => {
  const on = context.mock.method(Worker.prototype, 'on');
  const memory = createTestMemory(256n);
  const handle = createHandle(memory);
  const startup = handle.start();
  const worker = on.mock.calls.findLast((call) => call.arguments[0] === 'message')?.this;
  assert.ok(worker instanceof Worker);
  return { worker, handle, startup };
};

const workerHosts = [
  {
    name: 'CPU',
    createHandle: (memory: Memory) =>
      createCpu({ memory, resetPc: guest(0n), deviceTreeAddress: null }),
  },
  { name: 'Timer', createHandle: (memory: Memory) => createTimer({ memory }) },
  {
    name: 'Terminal',
    createHandle: (memory: Memory) =>
      createTerminal({ memory, stdin: new PassThrough(), stdout: new PassThrough() }),
  },
];

describe('shared Worker startup timeout', () => {
  it(
    'uses the subclass timeout instead of the previous five-second threshold',
    { timeout: 5_000 },
    async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const { worker, handle, startup } = observeStartup(
        context,
        (memory) => new StartupTimeoutWorker(memory)
      );
      let startupSettled = false;
      let joined = false;
      void startup.then(
        () => {
          startupSettled = true;
        },
        () => {
          startupSettled = true;
        }
      );
      void handle.then(
        () => {
          joined = true;
        },
        () => {
          joined = true;
        }
      );
      try {
        context.mock.timers.tick(5_000);
        await Promise.resolve();
        assert.equal(startupSettled, false, 'startup must remain pending after five seconds');
        assert.equal(joined, false);

        context.mock.timers.tick(TEST_STARTUP_TIMEOUT_MS - 5_000 - 1);
        await Promise.resolve();
        assert.equal(startupSettled, false, 'startup must remain pending until 11,999 ms');
        assert.equal(joined, false);

        context.mock.timers.tick(1);
        const error = await startup.catch((reason: unknown) => reason);
        assert.match(String(error), /Timed out/);
        assert.equal(worker.listenerCount('message'), 0);
        await assert.rejects(handle, (reason: unknown) => reason === error);
        assert.equal(joined, true, 'lifetime joins the exit following startup rejection');
      } finally {
        context.mock.timers.tick(TEST_STARTUP_TIMEOUT_MS);
        await worker.terminate();
        await handle.stop().catch(() => {});
      }
    }
  );
});

for (const { name, createHandle } of workerHosts) {
  describe(`${name} host startup event handling`, () => {
    it(
      'readiness settles only startup and disarms its timeout/listener',
      { timeout: 5_000 },
      async (context) => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        const { worker, handle, startup } = observeStartup(context, createHandle);
        let joined = false;
        void handle.then(
          () => {
            joined = true;
          },
          () => {
            joined = true;
          }
        );
        try {
          worker.emit('message', 'ready');
          await startup;
          assert.equal(joined, false);
          assert.equal(worker.listenerCount('message'), 0);
          context.mock.timers.tick(5_000);
          await handle.stop();
          assert.equal(joined, true);
        } finally {
          await worker.terminate();
          await handle.stop().catch(() => {});
        }
      }
    );

    for (const readyFirst of [false, true]) {
      it(
        `preserves the actual worker error ${readyFirst ? 'after' : 'before'} readiness until exit`,
        { timeout: 5_000 },
        async (context) => {
          const { worker, handle, startup } = observeStartup(context, createHandle);
          const error = new Error('actual worker failure');
          let joined = false;
          void handle.then(
            () => {
              joined = true;
            },
            () => {
              joined = true;
            }
          );
          try {
            if (readyFirst) {
              worker.emit('message', 'ready');
              await startup;
            }
            worker.emit('error', error);
            if (!readyFirst) {
              await assert.rejects(startup, (reason: unknown) => reason === error);
            }
            assert.equal(joined, false, 'error must not settle lifetime before exit');
            assert.equal(worker.listenerCount('message'), 0);
            await worker.terminate();
            await assert.rejects(handle, (reason: unknown) => reason === error);
            await assert.rejects(handle.stop(), (reason: unknown) => reason === error);
          } finally {
            await worker.terminate();
            await handle.stop().catch(() => {});
          }
        }
      );
    }

    it(
      'rejects startup on a premature clean exit without leaving it pending',
      { timeout: 5_000 },
      async (context) => {
        const { worker, handle, startup } = observeStartup(context, createHandle);
        try {
          worker.emit('exit', 0);
          await assert.rejects(startup, /exited before readiness/);
          await handle;
          assert.equal(worker.listenerCount('message'), 0);
        } finally {
          await worker.terminate();
          await handle.stop();
        }
      }
    );

    it(
      'stop waits for startup timeout and preserves its error after terminating',
      { timeout: 5_000 },
      async (context) => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        const { worker, handle, startup } = observeStartup(context, createHandle);
        try {
          const shutdown = handle.stop();
          assert.equal(handle.stop(), shutdown);
          context.mock.timers.tick(5_000);
          const error = await startup.catch((reason: unknown) => reason);
          assert.match(String(error), /Timed out/);
          await assert.rejects(shutdown, (reason: unknown) => reason === error);
          await assert.rejects(handle, (reason: unknown) => reason === error);
          assert.equal(worker.listenerCount('message'), 0);
        } finally {
          await worker.terminate();
          await handle.stop().catch(() => {});
        }
      }
    );

    it(
      'stop does not terminate or drain until pending startup becomes ready',
      { timeout: 5_000 },
      async (context) => {
        const { worker, handle, startup } = observeStartup(context, createHandle);
        const terminate = context.mock.method(worker, 'terminate');
        const postMessage = context.mock.method(worker, 'postMessage');
        try {
          const shutdown = handle.stop();
          assert.equal(handle.stop(), shutdown);
          assert.throws(() => handle.start(), /Already stopped/);
          assert.equal(terminate.mock.callCount(), 0);
          assert.equal(postMessage.mock.callCount(), 0);
          worker.emit('message', 'ready');
          await startup;
          await shutdown;
          assert.ok(terminate.mock.callCount() + postMessage.mock.callCount() > 0);
          assert.equal(worker.listenerCount('message'), 0);
        } finally {
          await worker.terminate();
          await handle.stop().catch(() => {});
        }
      }
    );
  });
}
