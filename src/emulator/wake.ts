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
 * Shared Int32 wake / level words (`Atomics.waitAsync` / `notify`).
 * Used by the IRQ-level aggregate and UART TX nonempty — not a generation counter.
 */

import { bytesToInt32Array } from '#utils/bytes';

/** Host bytes for one Int32 wake / level word. */
const WAKE_HOST_SIZE = 4;

/** Period for the `waitWake` keepalive timer (huge so the no-op callback never fires). */
const WAIT_ASYNC_KEEPALIVE_MS = 2 ** 30;

/**
 * Publish a level into the Int32 at `index` and `notify` when it changes.
 */
const publishWakeLevel = ({
  bytes,
  index,
  level,
}: {
  bytes: Uint8Array;
  index: number;
  level: number;
}): void => {
  const wake = bytesToInt32Array(bytes, index);
  const previous = Atomics.exchange(wake, 0, level);
  if (previous !== level) {
    Atomics.notify(wake, 0);
  }
};

/**
 * Sleep until the word at `index` differs from `fromLevel`.
 * Callers double-check their condition around loading `fromLevel`.
 */
const waitWake = async ({
  bytes,
  index,
  fromLevel,
}: {
  bytes: Uint8Array;
  index: number;
  fromLevel: number;
}): Promise<void> => {
  const wake = bytesToInt32Array(bytes, index);
  const result = Atomics.waitAsync(wake, 0, fromLevel);
  if (!result.async) {
    return;
  }
  // Node does not ref the event loop for a pending Atomics.waitAsync promise
  // (https://github.com/nodejs/node/issues/44729,
  // https://github.com/nodejs/node/issues/61941). With nothing else keeping the
  // isolate alive, notify can find a waiter but the promise never settles — and
  // waitAsync's own timeout is similarly inert. A dummy setInterval holds a libuv
  // handle for the duration of the await so the wake can run; the period is huge
  // so the callback is not meant to fire.
  const keepalive = setInterval(() => {}, WAIT_ASYNC_KEEPALIVE_MS);
  try {
    await result.value;
  } finally {
    clearInterval(keepalive);
  }
};

export { WAKE_HOST_SIZE, publishWakeLevel, waitWake };
