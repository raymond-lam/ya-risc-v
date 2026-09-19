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

/**
 * Host arguments to create the emulator (CPU + UART terminal workers).
 * DRAM base is `0x8000_0000`; UART is at `0x1000_0000`; CLINT is at `0x0200_0000`.
 * `ramSize` is required.
 */
type EmulatorCreateOptions = {
  /** Flat program image copied into guest RAM at the RAM base. */
  image: Uint8Array;
  /** Keystrokes into the guest (UART RX). */
  stdin: Readable;
  /** Bytes out of the guest (UART TX) for the host display. */
  stdout: Writable;
  /**
   * Guest DRAM size in bytes. Must be at least `image.byteLength` and must not
   * overlap the UART or CLINT windows.
   */
  ramSize: bigint;
};

type EmulatorHandle = Promise<void> & {
  /** Start the CPU, CLINT, and UART terminal workers. Throws if already started or already stopped. */
  start: () => void;
  /** Stop all workers. Throws if not started; idempotent after the first stop. */
  stop: () => void;
};

export type { EmulatorCreateOptions, EmulatorHandle };
