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
import type { Memory } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';

type Registers = {
  /** Integer GPRs: x0–x31. x0 is hardwired zero (read-only). */
  generalPurpose: readonly Uint8Array[] & {
    readonly 0: ReadonlyUint8Array;
  };
  /** Program counter (architectural, not a CSR). */
  programCounter: Uint8Array;
  /**
   * Dense CSR file keyed by 12-bit index. Only the implemented set is guest-accessible;
   * identity CSRs (mvendorid, marchid, mimpid, mhartid) are read-only. `sstatus`/`sie`/`sip`
   * are aliases of `mstatus`/`mie`/`mip` (handled in the register helpers, not separate slots).
   */
  controlAndStatus: readonly Uint8Array[] & {
    readonly 0xf11: ReadonlyUint8Array; // mvendorid
    readonly 0xf12: ReadonlyUint8Array; // marchid
    readonly 0xf13: ReadonlyUint8Array; // mimpid
    readonly 0xf14: ReadonlyUint8Array; // mhartid
  };
  /**
   * Current privilege mode as an 8-byte little-endian value (U=0, S=1, M=3).
   * Internal hart state, not a CSR; reset = M.
   */
  privilegeMode: Uint8Array;
};

/**
 * Host arguments to create the CPU worker. The worker creates its own registers.
 */
type CpuCreateOptions = {
  /** Shared guest address space (RAM + UART registers/queues in one SharedArrayBuffer). */
  memory: Memory;
  /** Reset PC as an 8-byte little-endian value (immutable after handoff). */
  resetPc: ReadonlyUint8Array;
};

/** Startup payload handed to the CPU worker (same fields as host options today). */
type CpuWorkerData = CpuCreateOptions;

type CpuHandle = Promise<void> & {
  /** Spawn the CPU worker. Throws if already started or already stopped. */
  start: () => void;
  /** Stop the worker. Throws if not started; idempotent after the first stop. */
  stop: () => void;
};

export type { Registers, CpuCreateOptions, CpuWorkerData, CpuHandle };
