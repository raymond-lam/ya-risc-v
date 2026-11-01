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
import { createMemory, type Memory } from '#emulator/memory';
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
import { create as createVirtioDisk, type VirtioDiskHandle } from '#emulator/virtio/host';
import {
  VIRTIO_HOST_DISK_READY,
  storeVirtioDevicePresent,
  virtioHostInt32,
} from '#emulator/virtio/layout';
import { storeDeviceTreeToRam } from '#fdt';
import { bytesToBigInt } from '#utils/bytes';

/** Upper bound on waiting for the disk worker to publish readiness (§FIX 1). The failure
 *  path publishes a sentinel immediately, so this only bounds a hard worker crash. */
const VIRTIO_DISK_READY_TIMEOUT_MS = 5000;

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

  readonly #disk: VirtioDiskHandle | null;

  readonly #done: Promise<void>;

  readonly #memory: ReturnType<typeof createMemory>;

  #started = false;

  #stopped = false;

  constructor({
    image,
    stdin,
    stdout,
    guestRegions,
    timebaseHz,
    deviceTreeAddress,
    resetPc,
    diskImagePath = null,
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
    // only once the disk worker is fully ready (§FIX 1). Diskless stays 0 (probes read 0).
    initializeVirtio(memory, false);
    this.#memory = memory;
    const disk: VirtioDiskHandle | null =
      diskImagePath === null ? null : createVirtioDisk({ memory, diskImagePath });
    storeImageToRam(memory, image);
    // Diskless: omit the virtio window from the map the device tree sees so no
    // `virtio_mmio` node is emitted (WP3's machineNode keyed off this map).
    const guestRegionsForDeviceTree: ReadonlyMap<string, GuestRegionWindow> =
      diskImagePath === null
        ? new Map([...guestRegions].filter(([id]) => id !== VIRTIO_REGION_ID))
        : guestRegions;
    const cpu = createCpu({
      memory,
      resetPc,
      deviceTreeAddress:
        deviceTreeAddress === null
          ? null
          : storeDeviceTreeToRam(
              memory,
              guestRegionsForDeviceTree,
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
    this.#disk = disk;
    this.#done = (async () => {
      const workers: Promise<void>[] = [cpu, timer, terminal];
      if (disk !== null) {
        workers.push(disk);
      }
      try {
        await Promise.all(workers);
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
      if (this.#disk !== null) {
        this.#disk.start();
        // Wait for the disk worker to be fully ready, then present the device BEFORE the
        // CPU starts fetching — the guest's first probe must already see a coherent device
        // (atomic appearance, §FIX 1). On open failure the worker publishes a sentinel and
        // device-present stays 0 (the guest probe reads an absent device).
        this.#presentDiskDevice();
      }
      this.#cpu.start();
      this.#terminal.start();
    } catch (error) {
      this.#cpu.stop();
      this.#timer.stop();
      this.#terminal.stop();
      this.#disk?.stop();
      this.#stopped = true;
      throw error;
    }
    this.#started = true;
    void this.#watchSyscon();
  };

  stop = (): void => {
    if (this.#stopped) {
      return;
    }
    // Idempotent: safe before start, after partial-start rollback, and after stop.
    this.#stopped = true;
    cancelSysconWatch(this.#memory);
    this.#cpu.stop();
    this.#timer.stop();
    this.#terminal.stop();
    this.#disk?.stop();
  };

  #watchSyscon = async (): Promise<void> => {
    const request = await watchSyscon(this.#memory);
    if (this.#stopped || request === 'idle') {
      return;
    }
    this.stop();
  };

  /** Wait (bounded) for the disk worker's readiness, then flip device-present on success. */
  #presentDiskDevice = (): void => {
    const ready = virtioHostInt32(this.#memory, VIRTIO_HOST_DISK_READY);
    Atomics.wait(ready, 0, 0, VIRTIO_DISK_READY_TIMEOUT_MS);
    if (Atomics.load(ready, 0) === 1) {
      storeVirtioDevicePresent(this.#memory, true);
    }
  };

  get memory(): Memory {
    return this.#memory;
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

const create = (options: EmulatorCreateOptions): EmulatorHandle => new Emulator(options);

export { create };
export type { EmulatorHandle } from '#emulator/types';
