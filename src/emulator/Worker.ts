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

import { Worker as NodeWorker, type WorkerOptions } from 'node:worker_threads';
import workerExecArgv from '#utils/worker-exec-argv';

/* eslint-disable no-restricted-syntax -- Promise wrapper needs a constructor and promise methods */
abstract class Worker implements Promise<void> {
  readonly [Symbol.toStringTag] = 'Promise';

  readonly #lifetime = Promise.withResolvers<void>();

  readonly #startup = Promise.withResolvers<void>();

  readonly #displayName: string;

  readonly #workerUrl: URL;

  #worker: NodeWorker | undefined;

  #shutdown: Promise<void> | undefined;

  #shutdownRequested = false;

  constructor(displayName: string, workerUrl: URL) {
    this.#displayName = displayName;
    this.#workerUrl = workerUrl;
    void this.#lifetime.promise.catch(() => {});
    void this.#startup.promise.catch(() => {});
  }

  start = (): Promise<void> => {
    if (this.#shutdown !== undefined) {
      throw new Error('Already stopped.');
    }
    if (this.#worker !== undefined) {
      throw new Error('Already started.');
    }
    const worker = new NodeWorker(this.#workerUrl, {
      execArgv: workerExecArgv(),
      ...this.createWorkerOptions(),
    });
    this.#worker = worker;
    let pending = true;
    let workerError: Error | undefined;
    // Readiness is separate from lifetime; settlement removes the timer and listener.
    const settleStartup = (error?: Error): void => {
      if (!pending) {
        return;
      }
      pending = false;
      clearTimeout(startupTimer);
      worker.off('message', onMessage);
      if (error !== undefined) {
        this.#startup.reject(error);
      } else {
        this.onReady();
        this.#startup.resolve();
      }
    };
    const onMessage = (message: unknown): void => {
      if (message === 'ready') {
        settleStartup();
      }
    };
    const startupTimer = setTimeout(() => {
      workerError = new Error(`Timed out waiting for the ${this.#displayName} worker.`);
      settleStartup(workerError);
      void worker.terminate().catch(this.#lifetime.reject);
    }, 5_000);
    worker.on('message', onMessage);
    worker.once('error', (error: Error) => {
      workerError = error;
      settleStartup(error);
    });
    worker.once('exit', (code) => {
      this.onExit();
      settleStartup(
        workerError ??
          new Error(`${this.#displayName} worker exited before readiness (code ${code}).`)
      );
      if (workerError !== undefined) {
        this.#lifetime.reject(workerError);
      } else if (this.#shutdownRequested || code === 0) {
        this.#lifetime.resolve();
      } else {
        this.#lifetime.reject(new Error(`${this.#displayName} worker exited with code ${code}`));
      }
    });
    return this.#startup.promise;
  };

  stop = (): Promise<void> => {
    if (this.#shutdown !== undefined) {
      return this.#shutdown;
    }
    this.#shutdown = (async () => {
      if (this.#worker !== undefined) {
        await this.#startup.promise.catch(() => {});
      }
      this.#shutdownRequested = true;
      if (this.#worker !== undefined) {
        this.stopWorker(this.#worker);
      } else {
        // Never started (or start failed before worker assignment): unblock awaiters.
        this.#lifetime.resolve();
      }
      await this.#lifetime.promise;
    })();
    return this.#shutdown;
  };

  protected abstract createWorkerOptions: () => Pick<WorkerOptions, 'workerData' | 'transferList'>;

  protected onReady = (): void => {};

  protected onExit = (): void => {};

  protected stopWorker(worker: NodeWorker): void {
    void worker.terminate().catch(this.#lifetime.reject);
  }

  then = this.#lifetime.promise.then.bind(this.#lifetime.promise);

  catch = this.#lifetime.promise.catch.bind(this.#lifetime.promise);

  finally = this.#lifetime.promise.finally.bind(this.#lifetime.promise);
}

export default Worker;
