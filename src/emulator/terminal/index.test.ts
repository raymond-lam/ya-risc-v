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
import { setTimeout as delay } from 'node:timers/promises';
import { loadBytes, storeBytes } from '#emulator/memory';
import { create } from '#emulator/terminal';
import { create as createTimer } from '#emulator/timer';
import createTestMemory from '#test/guest-memory';
import { unsignedBigIntToBytes } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';

const UART_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x1000_0000n) as ReadonlyUint8Array;

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

describe('terminal worker', () => {
  it('pushes stdin bytes into UART RX and drains UART TX to stdout', async () => {
    const memory = createTestMemory(256n);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const terminal = create({ memory, stdin, stdout });
    terminal.start();

    try {
      const received = new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('timed out waiting for UART TX on stdout'));
        }, 2000);
        stdout.once('data', (chunk: Buffer | string) => {
          clearTimeout(timer);
          resolve(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
      });

      storeBytes({
        memory,
        address: UART_BASE,
        source: new Uint8Array([0x21]),
        byteLength: 1,
      });
      assert.deepEqual(await received, Buffer.from([0x21]));

      stdin.write('A');
      const rbr = new Uint8Array(1);
      let rx = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await delay(10);
        loadBytes({
          destination: rbr,
          memory,
          address: UART_BASE,
          byteLength: 1,
        });
        rx = rbr[0] ?? 0;
        if (rx !== 0) {
          break;
        }
      }
      assert.equal(rx, 0x41);
    } finally {
      terminal.stop();
      await terminal;
    }
  });

  it('stop on an already-started worker resolves its lifetime instead of hanging', async () => {
    const memory = createTestMemory(256n);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const timer = createTimer({ memory });
    const terminal = create({ memory, stdin, stdout });
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

  it(
    'stop flushes TX bytes already queued in the UART ring to stdout',
    { timeout: 20_000 },
    async () => {
      const memory = createTestMemory(256n);
      // Queue 'd','r','a','i','n' into the TX ring before the worker even starts:
      // the drain handshake must hand every pre-stop byte to stdout instead of
      // letting the isolate exit and destroy the buffered writes.
      const queued = Uint8Array.of(0x64, 0x72, 0x61, 0x69, 0x6e);
      for (const byte of queued) {
        storeBytes({
          memory,
          address: UART_BASE,
          source: new Uint8Array([byte]),
          byteLength: 1,
        });
      }
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const terminal = create({ memory, stdin, stdout });
      terminal.start();
      // Stop arrives while those bytes are still queued; the worker's stop path
      // drains the ring before its final `end` + `finish` flush.
      terminal.stop();

      const received: Buffer[] = [];
      stdout.on('data', (chunk: Buffer | string) => {
        received.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      const flushed = (): Buffer => Buffer.concat(received);
      const deadline = Date.now() + 2000;
      while (flushed().length < queued.length) {
        if (Date.now() > deadline) {
          assert.fail(`stdout got ${JSON.stringify(flushed())} within 2000ms`);
        }
        await delay(10);
      }
      assert.deepEqual(flushed(), Buffer.from(queued));

      // The lifetime settles once the drained worker exits; no hang.
      await Promise.race([
        terminal.then(() => undefined),
        delay(2000).then(() => {
          throw new Error('terminal lifetime did not settle within 2000ms');
        }),
      ]);
    }
  );
});
