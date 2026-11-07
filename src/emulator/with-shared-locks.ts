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

import { waitWake } from '#emulator/wake';
import { bytesToInt32Array } from '#utils/bytes';

/** Release the acquired prefix in reverse order and wake a waiter for each lock. */
const releaseLocks = (locks: readonly Int32Array[], count: number): void => {
  for (let index = count - 1; index >= 0; index -= 1) {
    const lock = locks[index]!;
    Atomics.store(lock, 0, 0);
    Atomics.notify(lock, 0, 1);
  }
};

/** Run a synchronous operation under all the locks. Never wait while holding a partial set. */
const withSharedLocks = async (
  bytes: Uint8Array,
  indexes: readonly number[],
  run: () => void
): Promise<void> => {
  if (new Set(indexes).size !== indexes.length) {
    throw new Error('Cannot acquire the same lock twice.');
  }
  // Validate all lock views before acquiring any, so an invalid index cannot leak a lock.
  const locks = indexes.map((index) => bytesToInt32Array(bytes, index));
  for (;;) {
    let acquired = 0;
    while (acquired < locks.length && Atomics.compareExchange(locks[acquired]!, 0, 0, 1) === 0) {
      acquired += 1;
    }
    if (acquired === locks.length) {
      try {
        run();
        return;
      } finally {
        releaseLocks(locks, acquired);
      }
    }
    releaseLocks(locks, acquired);
    await waitWake({ bytes, index: indexes[acquired]!, fromLevel: 1 });
  }
};

export default withSharedLocks;
