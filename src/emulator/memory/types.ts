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

/* eslint-disable import/prefer-default-export -- Memory is the package's type module surface */
import type { ReadonlyUint8Array } from '#types';

/**
 * Guest address space: RAM, a 16550 UART register window, and a CLINT
 * (`msip` / `mtime` / `mtimecmp`), with UART RX/TX queues and CLINT shadows packed into one
 * SharedArrayBuffer (queues and CLINT shadows are host-only packing, not a dense
 * physical-address map).
 *
 * Vocabulary:
 *   - **address** — guest physical address (8-byte little-endian `Uint8Array`)
 *   - **index** — host TypedArray index into `memory.bytes` (`number`)
 *
 * Guest physical-address layout:
 *   [ramBaseAddress, ramBaseAddress + ramSize) — DRAM
 *   [uartBaseAddress, uartBaseAddress + 8)     — UART registers (fixed)
 *   clintBaseAddress + 0x0000                 — msip (4 bytes; bit 0)
 *   clintBaseAddress + 0x4000                 — mtimecmp (8 bytes)
 *   clintBaseAddress + 0xbff8                 — mtime (8 bytes)
 *
 * Host packing in `bytes` (indices; sparse guest map; no hole allocated) is computed
 * once by `guestMemoryHostLayout` (`memory/layout.ts`) and stored on this type:
 *   [RAM][UART registers][pad to 4][queue meta][RX ring][TX ring][pad to 8][CLINT]
 *   [pad to 4][hart wake Int32]
 *
 * The CLINT tick worker (`#emulator/clint/run`) advances `mtime` and drives the timer
 * wire; guest `msip` stores drive the software wire; the hart samples both
 * (`#emulator/memory`) into `mip.MTIP` / `mip.MSIP`. CLINT wire 0→1 asserts call
 * `notifyHartWake` so a hart in `wfi` wakes via `Atomics.wait` on the hart-wake word.
 *
 * Guest bases/`ramSize` participate in physical-address math as `bigint`. Host indices
 * are `number`.
 * Loads/stores to RBR/THR/LSR go through UART queue side effects, not plain RAM semantics.
 */
type Memory = {
  bytes: Uint8Array;
  ramBaseAddress: ReadonlyUint8Array;
  /** Guest-mapped RAM size (also the host DRAM slab length). */
  ramSize: bigint;
  uartBaseAddress: ReadonlyUint8Array;
  clintBaseAddress: ReadonlyUint8Array;
  /** Host index of the UART register-shadow bytes. */
  uartRegistersHostIndex: number;
  /** Host index of the Int32 UART queue metadata (rx/tx head and tail). */
  uartMetaHostIndex: number;
  /** Host index of the first UART RX ring byte. */
  uartRxDataHostIndex: number;
  /** Host index of the first UART TX ring byte. */
  uartTxDataHostIndex: number;
  /** Host index of the CLINT shadow region (8-byte aligned). */
  clintHostBaseIndex: number;
  /** Host index of the Int32 `wfi` wake word (`Atomics.wait` / `notify`). */
  hartWakeHostIndex: number;
};

export type { Memory };
