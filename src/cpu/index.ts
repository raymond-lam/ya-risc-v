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

import { Worker } from 'node:worker_threads';
import type { CpuWorkerData } from '#cpu/types.js';

type CpuRunHandle = Promise<void> & {
  terminate: () => void;
};

/* eslint-disable no-restricted-syntax -- Promise wrapper needs a constructor and promise methods */
class CpuRun implements CpuRunHandle {
  readonly [Symbol.toStringTag] = 'Promise';

  readonly #done: Promise<void>;

  readonly terminate: () => void;

  constructor(worker: Worker) {
    this.#done = new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', () => {
        resolve();
      });
    });
    this.terminate = () => {
      void worker.terminate();
    };
  }

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): Promise<TResult1 | TResult2> {
    return this.#done.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined
  ): Promise<void | TResult> {
    return this.#done.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): Promise<void> {
    return this.#done.finally(onfinally);
  }
}

/* eslint-disable import/prefer-default-export -- public CPU host API */
const run = ({ memory, resetPc }: CpuWorkerData): CpuRunHandle => {
  const worker = new Worker(new URL(import.meta.resolve('#cpu/run.js')), {
    workerData: { memory, resetPc } satisfies CpuWorkerData,
  });

  return new CpuRun(worker);
};

export { run };
