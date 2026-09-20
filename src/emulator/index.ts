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

import { create as createClint, type ClintHandle } from '#emulator/clint';
import { create as createCpu, type CpuHandle } from '#emulator/cpu';
import { createMemory, ramAddressToHostIndex } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';
import { create as createTerminal, type TerminalHandle } from '#emulator/terminal';
import { unsignedBigIntToBytes } from '#utils/bytes';
import type { EmulatorCreateOptions, EmulatorHandle } from '#emulator/types';

/** Default guest DRAM base address. */
const DEFAULT_RAM_BASE = unsignedBigIntToBytes(
  new Uint8Array(8),
  0x8000_0000n
) as ReadonlyUint8Array;

/** Fixed 16550 UART MMIO base. */
const DEFAULT_UART_BASE = unsignedBigIntToBytes(
  new Uint8Array(8),
  0x1000_0000n
) as ReadonlyUint8Array;

/** Fixed CLINT MMIO base (`msip` / `mtime` / `mtimecmp`). */
const DEFAULT_CLINT_BASE = unsignedBigIntToBytes(
  new Uint8Array(8),
  0x0200_0000n
) as ReadonlyUint8Array;

/* eslint-disable no-restricted-syntax -- Promise wrapper needs a constructor and promise methods */
class Emulator implements EmulatorHandle {
  readonly [Symbol.toStringTag] = 'Promise';

  readonly #cpu: CpuHandle;

  readonly #clint: ClintHandle;

  readonly #terminal: TerminalHandle;

  readonly #done: Promise<void>;

  #started = false;

  #stopped = false;

  constructor({ image, stdin, stdout, ramSize }: EmulatorCreateOptions) {
    if (ramSize < BigInt(image.byteLength)) {
      throw new RangeError(
        `image (${image.byteLength} bytes) does not fit in ramSize (${ramSize} bytes).`
      );
    }

    const ramBaseAddress = DEFAULT_RAM_BASE;
    const uartBaseAddress = DEFAULT_UART_BASE;
    const clintBaseAddress = DEFAULT_CLINT_BASE;
    const memory = createMemory({
      ramBaseAddress,
      ramSize,
      uartBaseAddress,
      clintBaseAddress,
    });
    const dramHostIndex = ramAddressToHostIndex(memory, ramBaseAddress);
    if (dramHostIndex === null) {
      throw new RangeError('RAM base address is not mapped.');
    }
    memory.bytes.set(image, dramHostIndex);

    const cpu = createCpu({
      memory,
      resetPc: ramBaseAddress,
    });
    const clint = createClint({ memory });
    const terminal = createTerminal({
      memory,
      stdin,
      stdout,
    });
    this.#cpu = cpu;
    this.#clint = clint;
    this.#terminal = terminal;
    this.#done = (async () => {
      await Promise.all([cpu, clint, terminal]);
    })();
  }

  start = (): void => {
    if (this.#stopped) {
      throw new Error('Already stopped.');
    }
    if (this.#started) {
      throw new Error('Already started.');
    }
    this.#started = true;
    this.#clint.start();
    this.#cpu.start();
    this.#terminal.start();
  };

  stop = (): void => {
    if (!this.#started) {
      throw new Error('Not started.');
    }
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#cpu.stop();
    this.#clint.stop();
    this.#terminal.stop();
  };

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

const create = (options: EmulatorCreateOptions): EmulatorHandle => new Emulator(options);

export { create };
export type { EmulatorCreateOptions, EmulatorHandle } from '#emulator/types';
