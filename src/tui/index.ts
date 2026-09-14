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

import { createElement } from 'react';
import { render } from 'ink';
import App from '#tui/components/App';
import type { Instance } from 'ink';
import type { Readable, Writable } from 'node:stream';

type TuiCreateOptions = {
  /** Keystrokes from the focused terminal (write side). */
  stdin: Writable;
  /** Bytes painted in the terminal pane (read side). */
  stdout: Readable;
  /** Invoked when the user clicks Shutdown. */
  onShutdown: () => void;
};

type TuiHandle = Promise<void> & {
  /** Mount the Ink app. */
  start: () => void;
  /** Unmount the Ink app, or settle immediately if it never started. */
  stop: () => void;
};

/* eslint-disable no-restricted-syntax -- Promise wrapper needs a constructor and promise methods */
class Tui implements TuiHandle {
  readonly [Symbol.toStringTag] = 'Promise';

  readonly #lifetime = Promise.withResolvers<void>();

  readonly #options: TuiCreateOptions;

  #instance: Instance | undefined;

  #started = false;

  #stopped = false;

  constructor(options: TuiCreateOptions) {
    this.#options = options;
  }

  start = (): void => {
    if (this.#started || this.#stopped) {
      return;
    }
    this.#started = true;
    const { stdin, stdout, onShutdown } = this.#options;
    const instance = render(createElement(App, { stdin, stdout, onShutdown }), {
      alternateScreen: true,
    });
    this.#instance = instance;
    void (async () => {
      await instance.waitUntilExit();
      this.#lifetime.resolve();
    })();
  };

  stop = (): void => {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    if (this.#instance !== undefined) {
      this.#instance.unmount();
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

const create = (options: TuiCreateOptions): TuiHandle => new Tui(options);

export { create };
export type { TuiCreateOptions, TuiHandle };
