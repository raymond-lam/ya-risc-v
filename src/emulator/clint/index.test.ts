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
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { create, isClintMachineTimerPending } from '#emulator/clint';
import { loadBytes, storeBytes } from '#emulator/memory';
import createTestMemory from '#test/guest-memory';
import { unsignedBigIntToBytes } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#emulator/memory';

/** CLINT register offsets relative to base — local to tests. */
const CLINT_MTIMECMP_OFFSET = 0x4000n;
const CLINT_MTIME_OFFSET = 0xbff8n;

const clintAddress = (offset: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), 0x0200_0000n + offset);

describe('clint worker', () => {
  it('advances mtime and asserts the timer wire when past mtimecmp', async () => {
    const memory = createTestMemory(256n);
    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      source: unsignedBigIntToBytes(new Uint8Array(8), 1n),
      byteLength: 8,
    });
    assert.equal(isClintMachineTimerPending(memory), false);

    const clint = create({ memory });
    clint.start();
    try {
      let pending = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await delay(10);
        if (isClintMachineTimerPending(memory)) {
          pending = true;
          break;
        }
      }
      assert.equal(pending, true);

      const mtime = new Uint8Array(8);
      loadBytes({
        destination: mtime,
        memory,
        address: clintAddress(CLINT_MTIME_OFFSET),
        byteLength: 8,
      });
      assert.ok(mtime.some((byte) => byte !== 0));
    } finally {
      clint.stop();
      await clint;
    }
  });
});
