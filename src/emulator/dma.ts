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
 * DMA seam for guest RAM. Every byte of a transfer must map to RAM; MMIO,
 * unmapped, and region-straddling spans are rejected.
 */

import type { Memory } from '#emulator/memory';
import { loadBytes, resolveGuestAddress, storeBytes } from '#emulator/memory';
import { RAM_REGION_ID } from '#emulator/ram';
import type { ReadonlyUint8Array } from '#types';

/**
 * Resolve `byteLength` bytes at `address` to a RAM-only span.
 * Returns the byte offset within the RAM guest window, or `null` on rejection.
 */
const resolveDmaSpan = (
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: number
): { offset: bigint } | null => {
  if (byteLength < 0) {
    return null;
  }
  const resolved = resolveGuestAddress(memory, address);
  if (resolved === null || resolved.regionId !== RAM_REGION_ID) {
    return null;
  }
  const ram = memory.regions.get(RAM_REGION_ID);
  if (ram === undefined || ram.guestAddress === null) {
    return null;
  }
  if (resolved.offset + BigInt(byteLength) > ram.guestByteLength) {
    return null;
  }
  return { offset: resolved.offset };
};

/** Load a complete RAM-only span into `destination`. */
const dmaLoad = (
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: number,
  destination: Uint8Array
): boolean => {
  if (destination.length < byteLength || resolveDmaSpan(memory, address, byteLength) === null) {
    return false;
  }
  loadBytes({ memory, address, destination, byteLength });
  return true;
};

/** Store a complete RAM-only span from `source`. */
const dmaStore = (
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: number,
  source: ReadonlyUint8Array
): boolean => {
  if (source.length < byteLength || resolveDmaSpan(memory, address, byteLength) === null) {
    return false;
  }
  storeBytes({ memory, address, source, byteLength });
  return true;
};

export { dmaLoad, dmaStore, resolveDmaSpan };
