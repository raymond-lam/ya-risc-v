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

/* eslint-disable import/prefer-default-export -- emulator create option / handle types */
import type { Readable, Writable } from 'node:stream';
import type { DeviceTreeAddress } from '#fdt';
import type { ReadonlyUint8Array } from '#types';

/**
 * Guest window for one region. Same fields `createMemory` stores for a
 * guest-mapped spec (`guestAddress`, `guestByteLength`).
 */
type GuestRegionWindow = {
  /** Guest physical base of this region's window. */
  readonly guestAddress: ReadonlyUint8Array;
  /** Guest-visible span length in bytes. */
  readonly guestByteLength: bigint;
};

/**
 * Host arguments to create the emulator (CPU + UART terminal workers).
 * The caller supplies every guest window. Host-only slabs stay inside the emulator.
 */
type EmulatorCreateOptions = {
  /** Flat program image copied into guest RAM at the RAM base. */
  image: Uint8Array;
  /** Keystrokes into the guest (UART RX). */
  stdin: Readable;
  /** Bytes out of the guest (UART TX) for the host display. */
  stdout: Writable;
  /**
   * Guest windows keyed by region id (`ram`, `uart`, `clint`, `plic`).
   * The `ram` window must cover `image`. Windows must not overlap.
   * The image is copied to the `ram` base. The hart fetches from `resetPc`.
   */
  guestRegions: ReadonlyMap<string, GuestRegionWindow>;
  /** Guest address of the first fetch. Must lie in the RAM window. */
  resetPc: ReadonlyUint8Array;
  /**
   * CLINT `mtime` frequency in hertz. Must be from 1 through 2^32-1.
   * Published as `/cpus` `timebase-frequency` and used to advance `mtime`.
   */
  timebaseHz: bigint;
  /**
   * Where to store the device tree. The stored guest address is passed to the hart as `a1`.
   * `'end'` is the top of the RAM window. `null` stores no blob and leaves `a1` zero.
   * A byte buffer is that guest physical address.
   */
  deviceTreeAddress: DeviceTreeAddress;
};

type EmulatorHandle = Promise<void> & {
  /** Start the CPU, CLINT, and UART terminal workers. Throws if already started or already stopped. */
  start: () => void;
  /** Stop all workers. Throws if not started; idempotent after the first stop. */
  stop: () => void;
};

export type { EmulatorCreateOptions, EmulatorHandle, GuestRegionWindow };
