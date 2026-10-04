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
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { create } from '#emulator';
import { create as createTerminal } from '#emulator/terminal';
import { create as createTimer } from '#emulator/timer';
import createTestMemory from '#test/guest-memory';

/** Minimal thenable handle that can reject like a worker lifetime. */
const createFailingHandle = (
  message: string
): PromiseLike<void> & {
  start: () => void;
  stop: () => void;
} => {
  const lifetime = Promise.withResolvers<void>();
  let stopped = false;
  return {
    start: (): void => {
      queueMicrotask(() => {
        if (!stopped) {
          lifetime.reject(new Error(message));
        }
      });
    },
    stop: (): void => {
      stopped = true;
      lifetime.resolve();
    },
    then: lifetime.promise.then.bind(lifetime.promise),
  };
};

describe('emulator create', () => {
  it('rejects an image that does not fit in ramSize', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    assert.throws(
      () =>
        create({
          image: new Uint8Array(16),
          stdin,
          stdout,
          ramSize: 8n,
        }),
      { name: 'RangeError', message: /does not fit in ramSize/ }
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
      ramSize: 4096n,
    });
    emulator.start();
    emulator.stop();
    await emulator;
  });

  it('stop before start is idempotent and unblocks await', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const image = new Uint8Array([0x73, 0x00, 0x50, 0x10]);
    const emulator = create({
      image,
      stdin,
      stdout,
      ramSize: 4096n,
    });
    emulator.stop();
    emulator.stop();
    await emulator;
    assert.throws(
      () => {
        emulator.start();
      },
      { message: 'Already stopped.' }
    );
  });

  it('timer and terminal stop before start is idempotent', async () => {
    const memory = createTestMemory(256n);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const timer = createTimer({ memory });
    const terminal = createTerminal({ memory, stdin, stdout });
    timer.stop();
    terminal.stop();
    timer.stop();
    terminal.stop();
    await Promise.all([timer, terminal]);
  });

  it('stops live timer and terminal workers when a sibling rejects', async () => {
    const memory = createTestMemory(256n);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const timer = createTimer({ memory });
    const terminal = createTerminal({ memory, stdin, stdout });
    const failing = createFailingHandle('forced worker failure');

    timer.start();
    terminal.start();
    failing.start();

    await assert.rejects(
      async () => {
        try {
          await Promise.all([failing, timer, terminal]);
        } finally {
          failing.stop();
          timer.stop();
          terminal.stop();
        }
      },
      { message: 'forced worker failure' }
    );

    // Siblings must have been stopped; otherwise these awaits hang.
    await Promise.all([timer, terminal]);
  });
});
