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

import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { tickClint } from '#emulator/memory';
import type { ClintWorkerData } from '#emulator/clint/types';

/** How often the timebase domain wakes to advance `mtime` and the timer wire. */
const CLINT_TICK_PERIOD_MS = 1;

const main = async (): Promise<void> => {
  const { memory } = workerData as ClintWorkerData;
  // Independent clock domain: keep ticking until the host terminates us.
  for (;;) {
    tickClint(memory);
    await delay(CLINT_TICK_PERIOD_MS);
  }
};

if (parentPort !== null) {
  void main();
}
