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
import workerExecArgv from '#utils/worker-exec-argv';
import type { ClintCreateOptions, ClintHandle, ClintWorkerData } from '#emulator/clint/types';

/* eslint-disable no-restricted-syntax -- Promise wrapper needs a constructor and promise methods */
class Clint implements ClintHandle {
  readonly [Symbol.toStringTag] = 'Promise';

  readonly #lifetime = Promise.withResolvers<void>();

  readonly #options: ClintCreateOptions;

  #worker: Worker | undefined;

  #started = false;

  #stopped = false;

  constructor(options: ClintCreateOptions) {
    this.#options = options;
  }

  start = (): void => {
    if (this.#stopped) {
      throw new Error('Already stopped.');
    }
    if (this.#started) {
      throw new Error('Already started.');
    }
    this.#started = true;
    const workerData = {
      memory: this.#options.memory,
    } satisfies ClintWorkerData;
    const worker = new Worker(new URL(import.meta.resolve('#emulator/clint/run')), {
      execArgv: workerExecArgv(),
      workerData,
    });
    this.#worker = worker;
    worker.once('error', (error) => {
      this.#lifetime.reject(error);
    });
    worker.once('exit', () => {
      this.#lifetime.resolve();
    });
  };

  stop = (): void => {
    if (!this.#started) {
      throw new Error('Not started.');
    }
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    if (this.#worker !== undefined) {
      void this.#worker.terminate();
      return;
    }
    this.#lifetime.resolve();
  };

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): Promise<TResult1 | TResult2> {
    return this.#lifetime.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined
  ): Promise<void | TResult> {
    return this.#lifetime.promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): Promise<void> {
    return this.#lifetime.promise.finally(onfinally);
  }
}

const create = (options: ClintCreateOptions): ClintHandle => new Clint(options);

export { create };
/** Re-export so unused host `create`/`Worker` can tree-shake out of workers. */
export { isClintMachineSoftwarePending, isClintMachineTimerPending } from '#emulator/clint/wire';
export type { ClintCreateOptions, ClintHandle } from '#emulator/clint/types';
