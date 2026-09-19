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
import type { ReadonlyUint8Array } from '#utils/bytes';

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
 * Host packing in `bytes` (indices; sparse guest map; no hole allocated):
 *   [0, ramSize)                         — DRAM
 *   [ramSize, ramSize + 8)               — UART register shadow (non-data/status)
 *   then aligned queue metadata + RX ring + TX ring (see `uartHostLayout`)
 *   then CLINT shadows + timer/software IRQ wires + epoch (see `memory/clint.ts`)
 *
 * The CLINT tick worker (`#emulator/clint/run`) advances `mtime` and drives the timer
 * wire; guest `msip` stores drive the software wire; the hart samples both
 * (`#emulator/clint`) into `mip.MTIP` / `mip.MSIP`.
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
  /** Host index of the CLINT shadow region in `bytes` (after UART packing). */
  clintHostBaseIndex: number;
};

export type { Memory };
