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
import createTestMemory from '#test/guest-memory';
import { unsignedBigIntToBytes } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';

const UART_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x1000_0000n) as ReadonlyUint8Array;

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
});
