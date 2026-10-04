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

import {
  CLINT_GUEST_BYTE_LENGTH,
  CLINT_HOST_BYTE_LENGTH,
  CLINT_REGION_ID,
  initializeClint,
} from '#emulator/clint';
import { create as createCpu, type CpuHandle } from '#emulator/cpu';
import { IRQ_LEVEL_HOST_BYTE_LENGTH, IRQ_LEVEL_REGION_ID } from '#emulator/irq-level';
import { createMemory } from '#emulator/memory';
import {
  initializePlic,
  PLIC_GUEST_BYTE_LENGTH,
  PLIC_HOST_BYTE_LENGTH,
  PLIC_REGION_ID,
} from '#emulator/plic';
import { RAM_REGION_ID, storeImageToRam } from '#emulator/ram';
import { RESERVATION_HOST_BYTE_LENGTH, RESERVATION_REGION_ID } from '#emulator/reservation';
import { create as createTerminal, type TerminalHandle } from '#emulator/terminal';
import { create as createTimer, type TimerHandle } from '#emulator/timer';
import { UART_GUEST_BYTE_LENGTH, UART_HOST_BYTE_LENGTH, UART_REGION_ID } from '#emulator/uart';
import type { EmulatorCreateOptions, EmulatorHandle } from '#emulator/types';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes } from '#utils/bytes';

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

/** Fixed PLIC MMIO base (UART IRQ = source 10). */
const DEFAULT_PLIC_BASE = unsignedBigIntToBytes(
  new Uint8Array(8),
  0x0c00_0000n
) as ReadonlyUint8Array;

/* eslint-disable no-restricted-syntax -- Promise wrapper needs a constructor and promise methods */
class Emulator implements EmulatorHandle {
  readonly [Symbol.toStringTag] = 'Promise';

  readonly #cpu: CpuHandle;

  readonly #timer: TimerHandle;

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
    const plicBaseAddress = DEFAULT_PLIC_BASE;
    // Pack order: ram → uart → clint → plic → reservation → irqLevel
    const memory = createMemory([
      {
        id: RAM_REGION_ID,
        hostByteLength: ramSize,
        guestAddress: ramBaseAddress,
        guestByteLength: ramSize,
      },
      {
        id: UART_REGION_ID,
        hostByteLength: UART_HOST_BYTE_LENGTH,
        guestAddress: uartBaseAddress,
        guestByteLength: UART_GUEST_BYTE_LENGTH,
      },
      {
        id: CLINT_REGION_ID,
        hostByteLength: CLINT_HOST_BYTE_LENGTH,
        guestAddress: clintBaseAddress,
        guestByteLength: CLINT_GUEST_BYTE_LENGTH,
      },
      {
        id: PLIC_REGION_ID,
        hostByteLength: PLIC_HOST_BYTE_LENGTH,
        guestAddress: plicBaseAddress,
        guestByteLength: PLIC_GUEST_BYTE_LENGTH,
      },
      {
        id: RESERVATION_REGION_ID,
        hostByteLength: RESERVATION_HOST_BYTE_LENGTH,
        guestAddress: null,
        guestByteLength: 0n,
      },
      {
        id: IRQ_LEVEL_REGION_ID,
        hostByteLength: IRQ_LEVEL_HOST_BYTE_LENGTH,
        guestAddress: null,
        guestByteLength: 0n,
      },
    ]);
    initializeClint(memory);
    initializePlic(memory);
    storeImageToRam(memory, image);

    const cpu = createCpu({
      memory,
      resetPc: ramBaseAddress,
    });
    const timer = createTimer({ memory });
    const terminal = createTerminal({
      memory,
      stdin,
      stdout,
    });
    this.#cpu = cpu;
    this.#timer = timer;
    this.#terminal = terminal;
    this.#done = (async () => {
      try {
        await Promise.all([cpu, timer, terminal]);
      } finally {
        this.stop();
      }
    })();
  }

  start = (): void => {
    if (this.#stopped) {
      throw new Error('Already stopped.');
    }
    if (this.#started) {
      throw new Error('Already started.');
    }
    // Start children; only mark started once all succeed. On failure, stop any
    // that already started (child stop is idempotent for never-started siblings).
    try {
      this.#timer.start();
      this.#cpu.start();
      this.#terminal.start();
    } catch (error) {
      this.#cpu.stop();
      this.#timer.stop();
      this.#terminal.stop();
      this.#stopped = true;
      throw error;
    }
    this.#started = true;
  };

  stop = (): void => {
    if (this.#stopped) {
      return;
    }
    // Idempotent: safe before start, after partial-start rollback, and after stop.
    this.#stopped = true;
    this.#cpu.stop();
    this.#timer.stop();
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
export type { EmulatorHandle } from '#emulator/types';
