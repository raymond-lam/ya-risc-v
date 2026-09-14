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

import { Readable, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import workerExecArgv from '#utils/worker-exec-argv';
import type {
  TerminalCreateOptions,
  TerminalHandle,
  TerminalWorkerData,
} from '#emulator/terminal/types';

/* eslint-disable no-restricted-syntax -- Promise wrapper needs a constructor and promise methods */
class Terminal implements TerminalHandle {
  readonly [Symbol.toStringTag] = 'Promise';

  readonly #lifetime = Promise.withResolvers<void>();

  readonly #options: TerminalCreateOptions;

  #worker: Worker | undefined;

  #started = false;

  #stopped = false;

  constructor(options: TerminalCreateOptions) {
    this.#options = options;
  }

  start = (): void => {
    if (this.#started || this.#stopped) {
      return;
    }
    this.#started = true;
    const stdinWeb = Readable.toWeb(this.#options.stdin);
    const stdoutWeb = Writable.toWeb(this.#options.stdout);
    const workerData = {
      memory: this.#options.memory,
      stdin: stdinWeb,
      stdout: stdoutWeb,
    } satisfies TerminalWorkerData;
    const worker = new Worker(new URL(import.meta.resolve('#emulator/terminal/run')), {
      execArgv: workerExecArgv(),
      workerData,
      transferList: [stdinWeb, stdoutWeb],
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

const create = (options: TerminalCreateOptions): TerminalHandle => new Terminal(options);

export { create };
export type { TerminalCreateOptions, TerminalHandle } from '#emulator/terminal/types';
