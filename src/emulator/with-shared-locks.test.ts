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
import withSharedLocks from '#emulator/with-shared-locks';

describe('withSharedLocks', () => {
  it(
    'releases earlier locks before parking and serializes all notified waiters',
    { timeout: 2000 },
    async () => {
      const bytes = new Uint8Array(new SharedArrayBuffer(8));
      const locks = new Int32Array(bytes.buffer);
      Atomics.store(locks, 1, 1);
      const order: number[] = [];
      try {
        const first = withSharedLocks(bytes, [0, 4], () => {
          assert.equal(Atomics.load(locks, 0), 1);
          assert.equal(Atomics.load(locks, 1), 1);
          order.push(1);
        });
        const second = withSharedLocks(bytes, [0, 4], () => {
          assert.equal(Atomics.load(locks, 0), 1);
          assert.equal(Atomics.load(locks, 1), 1);
          order.push(2);
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(order, []);
        assert.equal(Atomics.load(locks, 0), 0);
        Atomics.store(locks, 1, 0);
        assert.equal(Atomics.notify(locks, 1, 1), 1);
        await Promise.all([first, second]);
        assert.deepEqual([...order].sort(), [1, 2]);
        assert.equal(Atomics.load(locks, 0), 0);
        assert.equal(Atomics.load(locks, 1), 0);
      } finally {
        Atomics.store(locks, 0, 0);
        Atomics.store(locks, 1, 0);
        Atomics.notify(locks, 0);
        Atomics.notify(locks, 1);
      }
    }
  );

  it('rejects duplicate or misaligned locks before acquiring any', async () => {
    const bytes = new Uint8Array(new SharedArrayBuffer(8));
    const locks = new Int32Array(bytes.buffer);
    await assert.rejects(
      withSharedLocks(bytes, [0, 0], () => {}),
      /same lock twice/
    );
    await assert.rejects(
      withSharedLocks(bytes, [0, 1], () => {}),
      RangeError
    );
    assert.deepEqual([...locks], [0, 0]);
  });

  it('releases every lock when the transaction throws', async () => {
    const bytes = new Uint8Array(new SharedArrayBuffer(8));
    const locks = new Int32Array(bytes.buffer);
    await assert.rejects(
      withSharedLocks(bytes, [0, 4], () => {
        throw new Error('failed');
      }),
      /failed/
    );
    assert.deepEqual([...locks], [0, 0]);
    let ran = false;
    await withSharedLocks(bytes, [0, 4], () => {
      ran = true;
    });
    assert.equal(ran, true);
  });
});
