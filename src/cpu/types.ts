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

/* eslint-disable import/prefer-default-export -- CPU architectural state types */
import type ReadonlyUint8Array from '#ReadonlyUint8Array.js';

type Registers = {
  /** Integer GPRs: x0–x31. x0 is hardwired zero (read-only). */
  generalPurpose: readonly Uint8Array[] & {
    readonly 0: ReadonlyUint8Array;
  };
  /** Program counter (architectural, not a CSR). */
  programCounter: Uint8Array;
  /**
   * Dense CSR file keyed by 12-bit index.
   * Identity CSRs (mvendorid, marchid, mimpid, mhartid) are read-only.
   */
  controlAndStatus: readonly Uint8Array[] & {
    readonly 0xf11: ReadonlyUint8Array; // mvendorid
    readonly 0xf12: ReadonlyUint8Array; // marchid
    readonly 0xf13: ReadonlyUint8Array; // mimpid
    readonly 0xf14: ReadonlyUint8Array; // mhartid
  };
};

/**
 * Startup payload for the CPU worker. The host provides guest memory and the reset
 * vector; the worker creates its own registers.
 */
type CpuWorkerData = {
  /** Shared guest address space. */
  memory: Uint8Array;
  /** Reset PC as an 8-byte little-endian value. */
  resetPc: Uint8Array;
};

export type { Registers, CpuWorkerData };
