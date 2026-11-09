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

import { CLINT_HOST_BYTE_LENGTH, CLINT_REGION_ID, initializeClint } from '#emulator/clint';
import { create as createCpu, type CpuHandle } from '#emulator/cpu';
import { IRQ_LEVEL_HOST_BYTE_LENGTH, IRQ_LEVEL_REGION_ID } from '#emulator/irq-level';
import { createMemory } from '#emulator/memory';
import { initializePlic, PLIC_HOST_BYTE_LENGTH, PLIC_REGION_ID } from '#emulator/plic';
import { RAM_REGION_ID, storeImageToRam } from '#emulator/ram';
import { RESERVATION_HOST_BYTE_LENGTH, RESERVATION_REGION_ID } from '#emulator/reservation';
import {
  SYSCON_HOST_BYTE_LENGTH,
  SYSCON_REGION_ID,
  cancelSysconWatch,
  watchSyscon,
} from '#emulator/syscon';
import { create as createTerminal, type TerminalHandle } from '#emulator/terminal';
import { create as createTimer, type TimerHandle } from '#emulator/timer';
import type { EmulatorCreateOptions, EmulatorHandle, GuestRegionWindow } from '#emulator/types';
import { UART_HOST_BYTE_LENGTH, UART_REGION_ID } from '#emulator/uart';
import { VIRTIO_HOST_BYTE_LENGTH, VIRTIO_REGION_ID, initializeVirtio } from '#emulator/virtio';
import { storeDeviceTreeToRam } from '#fdt';
import { bytesToBigInt } from '#utils/bytes';

/** Guest-mapped region ids, in pack order. */
const GUEST_REGION_IDS: readonly string[] = [
  RAM_REGION_ID,
  UART_REGION_ID,
  CLINT_REGION_ID,
  PLIC_REGION_ID,
  SYSCON_REGION_ID,
  VIRTIO_REGION_ID,
];

const hostByteLength = (id: string, guestByteLength: bigint): bigint => {
  if (id === RAM_REGION_ID) {
    return guestByteLength;
  }
  if (id === UART_REGION_ID) {
    return UART_HOST_BYTE_LENGTH;
  }
  if (id === CLINT_REGION_ID) {
    return CLINT_HOST_BYTE_LENGTH;
  }
  if (id === PLIC_REGION_ID) {
    return PLIC_HOST_BYTE_LENGTH;
  }
  if (id === SYSCON_REGION_ID) {
    return SYSCON_HOST_BYTE_LENGTH;
  }
  if (id === VIRTIO_REGION_ID) {
    return VIRTIO_HOST_BYTE_LENGTH;
  }
  throw new RangeError(`Unknown guest region '${id}'.`);
};

const guestRegion = (
  guestRegions: ReadonlyMap<string, GuestRegionWindow>,
  id: string
): GuestRegionWindow => {
  const region = guestRegions.get(id);
  if (region === undefined) {
    throw new RangeError(`Missing guest region '${id}'.`);
  }
  return region;
};

/* eslint-disable no-restricted-syntax -- Promise wrapper needs a constructor and promise methods */
class Emulator implements EmulatorHandle {
  readonly [Symbol.toStringTag] = 'Promise';

  readonly #cpu: CpuHandle;

  readonly #timer: TimerHandle;

  readonly #terminal: TerminalHandle;

  readonly #done: Promise<void>;

  readonly #memory: ReturnType<typeof createMemory>;

  #started = false;

  #stopped = false;

  #startup: Promise<void> | undefined;

  #shutdown: Promise<void> | undefined;

  constructor({
    image,
    stdin,
    stdout,
    guestRegions,
    timebaseHz,
    deviceTreeAddress,
    resetPc,
  }: EmulatorCreateOptions) {
    for (const id of guestRegions.keys()) {
      if (!GUEST_REGION_IDS.includes(id)) {
        throw new RangeError(`Unknown guest region '${id}'.`);
      }
    }
    const ram = guestRegion(guestRegions, RAM_REGION_ID);
    if (ram.guestByteLength < BigInt(image.byteLength)) {
      throw new RangeError(
        `image (${image.byteLength} bytes) does not fit in ram region (${ram.guestByteLength} bytes).`
      );
    }

    // Pack order: ram → uart → clint → plic → syscon → virtio → reservation → irqLevel
    const memory = createMemory([
      ...GUEST_REGION_IDS.map((id) => {
        const region = guestRegion(guestRegions, id);
        return {
          id,
          hostByteLength: hostByteLength(id, region.guestByteLength),
          guestAddress: region.guestAddress,
          guestByteLength: region.guestByteLength,
        };
      }),
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
    const ramBase = bytesToBigInt(ram.guestAddress);
    const resetPcAddress = bytesToBigInt(resetPc);
    if (resetPcAddress < ramBase || resetPcAddress >= ramBase + ram.guestByteLength) {
      throw new RangeError('reset PC is outside the ram region.');
    }
    initializeClint(memory, timebaseHz);
    initializePlic(memory);
    // Device present starts 0 for every boot: the virtio disk worker host flips it to 1
    // only once the disk worker is fully ready. Diskless stays 0 (probes read 0).
    initializeVirtio(memory, false);
    this.#memory = memory;
    storeImageToRam(memory, image);
    const cpu = createCpu({
      memory,
      resetPc,
      deviceTreeAddress:
        deviceTreeAddress === null
          ? null
          : storeDeviceTreeToRam(
              memory,
              guestRegions,
              image.byteLength,
              timebaseHz,
              deviceTreeAddress
            ),
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
      const workers: Promise<void>[] = [cpu, timer, terminal];
      try {
        await Promise.all(workers);
      } catch (error) {
        await this.stop().catch(() => {});
        throw error;
      }
      await this.stop();
    })();
    void this.#done.catch(() => {});
  }

  start = (): Promise<void> => {
    if (this.#stopped) {
      throw new Error('Already stopped.');
    }
    if (this.#started) {
      throw new Error('Already started.');
    }
    this.#started = true;
    // Keep the raw startup phase separate from its failure cleanup: stop waits only for this phase.
    this.#startup = this.#start();
    const ready = this.#startup.catch(async (error: unknown) => {
      await this.stop().catch(() => {});
      throw error;
    });
    void ready.catch(() => {});
    return ready;
  };

  #start = async (): Promise<void> => {
    await this.#timer.start();
    await this.#terminal.start();
    await this.#cpu.start();
    void this.#watchSyscon().catch(() => {});
  };

  stop = (): Promise<void> => {
    if (this.#shutdown !== undefined) {
      return this.#shutdown;
    }
    this.#stopped = true;
    this.#shutdown = this.#stop();
    return this.#shutdown;
  };

  #stop = async (): Promise<void> => {
    let startupFailed = false;
    let startupError: unknown;
    if (this.#startup !== undefined) {
      await this.#startup.catch((error: unknown) => {
        startupFailed = true;
        startupError = error;
      });
    }
    cancelSysconWatch(this.#memory);
    const producers = await Promise.allSettled([this.#cpu.stop(), this.#timer.stop()]);
    // Join the producer before requesting terminal drain, including on failure.
    const terminal = await Promise.allSettled([this.#terminal.stop()]);
    if (startupFailed) {
      throw startupError;
    }
    for (const result of [...producers, ...terminal]) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
  };

  #watchSyscon = async (): Promise<void> => {
    const request = await watchSyscon(this.#memory);
    if (this.#stopped || request === 'idle') {
      return;
    }
    await this.stop();
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
