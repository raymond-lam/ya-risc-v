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

/**
 * Bounded safety net: how long the host waits for a drain-requested worker to
 * exit before force-terminating it. The drain path is purely event-driven
 * (`popUartTransmit` → `stdout.write` → `stdout.end` → `finish` → `exit(0)`), so
 * whenever the consumer keeps draining, the worker's `exit` event clears this
 * timer first and the fallback never fires. It is reachable when stdout stalls:
 * backpressure never relieves, the worker cannot flush, and it is terminated
 * after the bound — bounded, and lossy by design.
 */
const TERMINATE_FALLBACK_MS = 5_000;

/* eslint-disable no-restricted-syntax -- Promise wrapper needs a constructor and promise methods */
class Terminal implements TerminalHandle {
  readonly [Symbol.toStringTag] = 'Promise';

  readonly #lifetime = Promise.withResolvers<void>();

  readonly #options: TerminalCreateOptions;

  #worker: Worker | undefined;

  #exited = false;

  #started = false;

  #stopped = false;

  constructor(options: TerminalCreateOptions) {
    this.#options = options;
  }

  start = (): void => {
    if (this.#stopped) {
      throw new Error('Already stopped.');
    }
    if (this.#started) {
      throw new Error('Already started.');
    }
    const stdinWeb = Readable.toWeb(this.#options.stdin);
    const stdoutWeb = Writable.toWeb(this.#options.stdout);
    const workerData = {
      memory: this.#options.memory,
      stdin: stdinWeb,
      stdout: stdoutWeb,
    } satisfies TerminalWorkerData;
    // Assign worker before marking started so a constructor throw leaves state untouched.
    const worker = new Worker(new URL(import.meta.resolve('#emulator/terminal/run')), {
      execArgv: workerExecArgv(),
      workerData,
      transferList: [stdinWeb, stdoutWeb],
    });
    this.#worker = worker;
    this.#started = true;
    worker.once('error', (error) => {
      this.#lifetime.reject(error);
    });
    worker.once('exit', (code) => {
      this.#exited = true;
      if (this.#stopped || code === 0) {
        this.#lifetime.resolve();
        return;
      }
      this.#lifetime.reject(new Error(`Terminal worker exited with code ${code}`));
    });
  };

  stop = (): void => {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    if (this.#worker !== undefined) {
      const worker = this.#worker;
      // Bounded force-terminate fallback against a wedged worker: if the drain
      // request is somehow lost or the isolate hangs, terminate so the lifetime
      // cannot hang forever. Unreachable when the consumer keeps draining (the
      // `exit` listener clears the timer first); reachable when stdout stalls,
      // where termination after the bound is bounded and lossy by design. Skipped
      // when the worker has already exited (for example a clean guest poweroff
      // self-exited before stop): its `exit` event fired before this call, so no
      // timer is set and none lingers.
      if (!this.#exited) {
        const fallbackTimer = setTimeout(() => {
          void worker.terminate();
        }, TERMINATE_FALLBACK_MS);
        // `unref` so the fallback cannot keep the host process alive on its own.
        fallbackTimer.unref();
        worker.once('exit', () => clearTimeout(fallbackTimer));
      }
      // Signal the worker to drain the TX ring to stdout, flush, and exit. The
      // lifetime resolves on the worker's `exit` event (see start), never on
      // elapsed time. A dead worker (crashed or already exited) makes the send
      // fail; the exit listener has already settled the lifetime either way.
      try {
        worker.postMessage('stop');
      } catch {
        // Worker is gone; the lifetime is settled through the exit listener.
      }
      return;
    }
    // Never started (or start failed before worker assignment): unblock awaiters.
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
export type { TerminalHandle } from '#emulator/terminal/types';
