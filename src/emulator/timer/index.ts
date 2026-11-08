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
 * CLINT timebase host — `create` / `start` / `stop` (Worker).
 * Device API (MMIO, samples): `#emulator/clint`.
 */

import type { WorkerOptions } from 'node:worker_threads';
import Worker from '#emulator/Worker';
import type { TimerCreateOptions, TimerHandle, TimerWorkerData } from '#emulator/timer/types';

/* eslint-disable no-restricted-syntax -- Worker host needs a constructor */
class Timer extends Worker implements TimerHandle {
  readonly #options: TimerCreateOptions;

  constructor(options: TimerCreateOptions) {
    super('Timer', new URL(import.meta.resolve('#emulator/timer/run')));
    this.#options = options;
  }

  protected createWorkerOptions = (): Pick<WorkerOptions, 'workerData' | 'transferList'> => {
    const workerData = {
      memory: this.#options.memory,
    } satisfies TimerWorkerData;
    return { workerData };
  };
}

const create = (options: TimerCreateOptions): TimerHandle => new Timer(options);

export { create };
export type { TimerHandle } from '#emulator/timer/types';
