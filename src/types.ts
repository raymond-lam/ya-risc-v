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

/**
 * Byte buffer used only for reading. Plain `Uint8Array` values are assignable;
 * writes through this type are a type error. Type-level only — no runtime Proxy.
 */
type ReadonlyUint8Array = {
  readonly length: number;
  readonly [index: number]: number;
  [Symbol.iterator](): IterableIterator<number>;
};

/**
 * Guest address space: RAM and a 16550 UART register window packed into one SharedArrayBuffer.
 *
 * Guest PA layout:
 *   [ramBaseAddress, ramBaseAddress + ramSize)     — DRAM
 *   [uartBaseAddress, uartBaseAddress + 8)       — UART registers (fixed)
 *
 * Host packing in `bytes` (sparse guest map; no hole allocated):
 *   [0, ramSize)        — DRAM
 *   [ramSize, ramSize + 8) — UART register bytes
 *
 * Guest bases/`ramSize` participate in PA math as `bigint`. Indexes into `bytes` are `number`.
 */
type Memory = {
  bytes: Uint8Array;
  ramBaseAddress: ReadonlyUint8Array;
  /** Guest-mapped RAM size (also the host DRAM slab length). */
  ramSize: bigint;
  uartBaseAddress: ReadonlyUint8Array;
};

export type { Memory, ReadonlyUint8Array };
