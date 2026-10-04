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
 * Guest memory — pack regions into one SharedArrayBuffer and dispatch guest
 * load/store (and RV64A atomics) by region id.
 *
 * Vocabulary (use these names in code and comments — do not invent synonyms):
 *
 *   - **guestAddress** — 8-byte little-endian `Uint8Array`. The address the guest
 *     hart uses. May or may not map into the SAB.
 *   - **hostIndex** — `bigint` byte index into `memory.bytes` (the SAB). Everything
 *     in the SAB has a hostIndex; not everything has a guestAddress.
 *   - **region** — one contiguous SAB slab (`hostIndex` … `hostIndex + hostByteLength`),
 *     optionally exposed to the guest as a physical window
 *     (`guestAddress` … `guestAddress + guestByteLength`).
 *
 * Guest ↔ host is not onto either way:
 *
 *   - Guest holes (unmapped physical addresses, sparse MMIO gaps) have no hostIndex.
 *   - Host-only bytes (UART queues, IRQ wires, LR/SC monitor, wake words, …) have no
 *     guestAddress. Guest `loadBytes` / `storeBytes` never touch them; device code
 *     indexes the owning region's host slab (`bigIntAsNumber` at the TypedArray boundary).
 *
 * Within a guest-visible region:
 *
 *   - **Dense** (RAM, UART register window): guest offset `o` maps to
 *     `hostIndex + o` for `o < guestByteLength` (a prefix of the host slab; the rest
 *     of the slab is host-only).
 *   - **Sparse** (CLINT, PLIC): `guestByteLength` is the architectural window size;
 *     only decoded offsets inside that window are live, and they map to fixed
 *     offsets inside the packed host slab (not a linear prefix).
 *
 * Callers supply region specs to `createMemory` and initialize device shadows
 * (`initializeClint` / `initializePlic`). Devices look up by key
 * (`regions.get(UART_REGION_ID)`); guest decode binary-searches
 * `regionsByBaseGuestAddress`, then dispatches by id.
 */

import { CLINT_REGION_ID, loadBytesFromClint, storeBytesToClint } from '#emulator/clint';
import { loadBytesFromPlic, PLIC_REGION_ID, storeBytesToPlic } from '#emulator/plic';
import {
  atomicRamCompareExchange,
  atomicRamLoad,
  atomicRamStore,
  loadBytesFromRam,
  RAM_REGION_ID,
  storeBytesToRam,
} from '#emulator/ram';
import {
  invalidateOverlappingReservationsLocked,
  releaseScMonitorIfHeld,
  withMonitorLock,
} from '#emulator/reservation';
import { loadBytesFromUart, storeBytesToUart, UART_REGION_ID } from '#emulator/uart';
import type { ReadonlyUint8Array } from '#types';
import { alignUp } from '#utils/alignment';
import findLastIndex from '#utils/binary-search';
import { bytesToBigInt, compareUnsignedBytes } from '#utils/bytes';
import { bigIntAsNumber } from '#utils/int';
import { findOverlappingPair } from '#utils/ranges';

type Memory = {
  /**
   * The SharedArrayBuffer view. Index with a **hostIndex** (`bigIntAsNumber` at the
   * boundary). The property is fixed at create; byte contents stay mutable.
   */
  readonly bytes: Uint8Array;
  /**
   * Packed host slabs keyed by region id (insertion = pack order).
   * Device code uses `get`; guest resolve uses `regionsByBaseGuestAddress`.
   * Guest visibility is a discriminated union: host-only regions have
   * `guestAddress: null` and `guestByteLength: 0n`.
   */
  readonly regions: ReadonlyMap<
    string,
    {
      /** Byte index into `memory.bytes` where this region's host slab begins (8-byte aligned). */
      readonly hostIndex: bigint;
      /** Contiguous host bytes owned by this region (guest-visible prefix + host-only tail). */
      readonly hostByteLength: bigint;
    } & (
      | {
          /** Host-only: no guest `loadBytes` / `storeBytes` path. */
          readonly guestAddress: null;
          readonly guestByteLength: 0n;
        }
      | {
          /** Guest physical base of this region's window. */
          readonly guestAddress: ReadonlyUint8Array;
          /**
           * Guest-visible span length in bytes.
           * Dense regions: equals the addressable host prefix.
           * Sparse MMIO: architectural window size (holes inside are not host-backed).
           */
          readonly guestByteLength: bigint;
        }
    )
  >;
  /**
   * Guest-mapped `[guestAddress, id]` tuples sorted by guest base ascending.
   * Host-only regions are omitted. Built once at create for binary-search resolve.
   */
  readonly regionsByBaseGuestAddress: readonly (readonly [ReadonlyUint8Array, string])[];
};

/** Every region hostIndex is aligned to this many bytes. */
const REGION_HOST_ALIGN = 8n;

/**
 * Pack `regionSpecs` (in order) into one SharedArrayBuffer.
 *
 * Rejects overlapping guest windows. Each region's `hostIndex` is the previous
 * region's end, rounded up to 8 bytes. Guest address holes are never allocated;
 * pad between regions is only for alignment. Guest-mapped specs carry a window;
 * host-only use `guestAddress: null` / `guestByteLength: 0n`.
 */
const createMemory = (
  regionSpecs: readonly ({
    id: string;
    hostByteLength: bigint;
  } & (
    | {
        guestAddress: null;
        guestByteLength: 0n;
      }
    | {
        guestAddress: ReadonlyUint8Array;
        guestByteLength: bigint;
      }
  ))[]
): Memory => {
  const guestWindows = regionSpecs.flatMap((spec) =>
    spec.guestAddress === null
      ? []
      : [
          {
            name: spec.id,
            base: bytesToBigInt(spec.guestAddress),
            size: spec.guestByteLength,
          },
        ]
  );
  const overlap = findOverlappingPair(guestWindows);
  if (overlap !== null) {
    throw new RangeError(`${overlap.a.name} window overlaps ${overlap.b.name}.`);
  }

  const regions = new Map<string, NonNullable<ReturnType<Memory['regions']['get']>>>();
  const regionsByBaseGuestAddress: [ReadonlyUint8Array, string][] = [];
  let packedByteLength = 0n;

  for (const spec of regionSpecs) {
    if (spec.hostByteLength < 0n) {
      throw new RangeError(`Region '${spec.id}' hostByteLength must be non-negative.`);
    }
    if (spec.guestAddress !== null && spec.guestByteLength < 0n) {
      throw new RangeError(`Region '${spec.id}' guestByteLength must be non-negative.`);
    }
    if (regions.has(spec.id)) {
      throw new RangeError(`Duplicate memory region ID '${spec.id}'.`);
    }
    const hostIndex = alignUp(packedByteLength, REGION_HOST_ALIGN);
    const region = spec.guestAddress
      ? {
          hostIndex,
          hostByteLength: spec.hostByteLength,
          guestAddress: spec.guestAddress,
          guestByteLength: spec.guestByteLength,
        }
      : {
          hostIndex,
          hostByteLength: spec.hostByteLength,
          guestAddress: null,
          guestByteLength: 0n as const,
        };
    regions.set(spec.id, region);
    packedByteLength = hostIndex + spec.hostByteLength;
    if (spec.guestAddress !== null) {
      regionsByBaseGuestAddress.push([spec.guestAddress, spec.id]);
    }
  }

  regionsByBaseGuestAddress.sort((a, b) => compareUnsignedBytes(a[0], b[0]));

  return {
    bytes: new Uint8Array(new SharedArrayBuffer(bigIntAsNumber(packedByteLength))),
    regions,
    regionsByBaseGuestAddress,
  };
};

/**
 * Resolve a guestAddress to `{ regionId, offset }` within its guest window, or
 * `null` when unmapped. Binary-searches `regionsByBaseGuestAddress`.
 */
const resolveGuestAddressToRegionAndOffset = (
  memory: Memory,
  guestAddress: ReadonlyUint8Array
): { regionId: string; offset: bigint } | null => {
  const { regionsByBaseGuestAddress } = memory;
  const index = findLastIndex(
    regionsByBaseGuestAddress,
    (entry) => compareUnsignedBytes(entry[0], guestAddress) <= 0
  );
  if (index < 0) {
    return null;
  }
  const hit = regionsByBaseGuestAddress[index];
  if (hit === undefined) {
    return null;
  }
  const [, regionId] = hit;
  const region = memory.regions.get(regionId);
  if (region === undefined || region.guestAddress === null) {
    return null;
  }
  const address = bytesToBigInt(guestAddress);
  const base = bytesToBigInt(region.guestAddress);
  if (address < base || address >= base + region.guestByteLength) {
    return null;
  }
  return { regionId, offset: address - base };
};

type RegionLoadBytes = (args: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  byteLength: number;
}) => void;

type RegionStoreBytes = (args: {
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  source: ReadonlyUint8Array;
  byteLength: number;
}) => void;

type RegionAtomicLoadBytes = (args: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  byteLength: 4 | 8;
}) => boolean;

type RegionAtomicStoreBytes = (args: {
  memory: Memory;
  address: ReadonlyUint8Array;
  source: ReadonlyUint8Array;
  byteLength: 4 | 8;
}) => boolean;

type RegionAtomicCompareExchangeBytes = (args: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  byteLength: 4 | 8;
  expected: ReadonlyUint8Array;
  desired: ReadonlyUint8Array;
}) => boolean;

/** Loads from an unmapped guest address return zeros (destination already cleared). */
const loadBytesFromUnmapped: RegionLoadBytes = (_args) => {};

/** Stores to an unmapped guest address are ignored. */
const storeBytesToUnmapped: RegionStoreBytes = (_args) => {};

const UNMAPPED_LOAD_STORE = [loadBytesFromUnmapped, storeBytesToUnmapped] as const;

/**
 * regionId → `[loadBytesFromRegion, storeBytesToRegion]`.
 * Missing ids (and unmapped guest addresses) use `UNMAPPED_LOAD_STORE`.
 */
const REGION_LOAD_STORE: ReadonlyMap<string, readonly [RegionLoadBytes, RegionStoreBytes]> =
  new Map([
    [RAM_REGION_ID, [loadBytesFromRam, storeBytesToRam]],
    [UART_REGION_ID, [loadBytesFromUart, storeBytesToUart]],
    [CLINT_REGION_ID, [loadBytesFromClint, storeBytesToClint]],
    [PLIC_REGION_ID, [loadBytesFromPlic, storeBytesToPlic]],
  ]);

/** Atomic ops on non-RAM (or unmapped) regions fail — callers trap. */
const atomicLoadBytesNoop: RegionAtomicLoadBytes = (_args) => false;
const atomicStoreBytesNoop: RegionAtomicStoreBytes = (_args) => false;
const atomicCompareExchangeBytesNoop: RegionAtomicCompareExchangeBytes = (_args) => false;

const ATOMIC_NOOP_LOAD_STORE = [
  atomicLoadBytesNoop,
  atomicStoreBytesNoop,
  atomicCompareExchangeBytesNoop,
] as const;

/**
 * regionId → `[atomicLoad, atomicStore, atomicCompareExchange]`.
 * Only RAM implements atomics; other regions are no-ops that return `false`.
 */
const REGION_ATOMIC_LOAD_STORE: ReadonlyMap<
  string,
  readonly [RegionAtomicLoadBytes, RegionAtomicStoreBytes, RegionAtomicCompareExchangeBytes]
> = new Map([
  [RAM_REGION_ID, [atomicRamLoad, atomicRamStore, atomicRamCompareExchange]],
  [UART_REGION_ID, ATOMIC_NOOP_LOAD_STORE],
  [CLINT_REGION_ID, ATOMIC_NOOP_LOAD_STORE],
  [PLIC_REGION_ID, ATOMIC_NOOP_LOAD_STORE],
]);

/** Copy `byteLength` bytes from `memory` at guest `address` into `destination` (high bytes cleared). */
const loadBytes = ({
  destination,
  memory,
  address,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  byteLength: number;
}): Uint8Array => {
  destination.fill(0);
  const resolved = resolveGuestAddressToRegionAndOffset(memory, address);
  if (resolved === null) {
    return destination;
  }
  const { regionId, offset } = resolved;
  const [loadBytesFromRegion] = REGION_LOAD_STORE.get(regionId) ?? UNMAPPED_LOAD_STORE;
  loadBytesFromRegion({ destination, memory, address, offset, byteLength });
  return destination;
};

/** Copy `byteLength` bytes from `source` into `memory` at guest `address`. */
const storeBytes = ({
  memory,
  address,
  source,
  byteLength,
}: {
  memory: Memory;
  address: ReadonlyUint8Array;
  source: ReadonlyUint8Array;
  byteLength: number;
}): void => {
  try {
    // Hold the LR/SC monitor across invalidate and the write so a remote hart
    // cannot arm a reservation in the gap (same critical section SC uses).
    withMonitorLock(memory, () => {
      invalidateOverlappingReservationsLocked(memory, address, byteLength);
      const resolved = resolveGuestAddressToRegionAndOffset(memory, address);
      if (resolved === null) {
        return;
      }
      const { regionId, offset } = resolved;
      const [, storeBytesToRegion] = REGION_LOAD_STORE.get(regionId) ?? UNMAPPED_LOAD_STORE;
      storeBytesToRegion({ memory, address, offset, source, byteLength });
    });
  } finally {
    releaseScMonitorIfHeld(memory);
  }
};

/**
 * Atomic load of a naturally aligned 32-bit or 64-bit location into `destination`.
 * Returns `false` when unmapped, non-RAM, or misaligned.
 */
const atomicLoadBytes = ({
  destination,
  memory,
  address,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  byteLength: 4 | 8;
}): boolean => {
  const resolved = resolveGuestAddressToRegionAndOffset(memory, address);
  if (resolved === null) {
    return false;
  }
  const [atomicLoadBytesFromRegion] =
    REGION_ATOMIC_LOAD_STORE.get(resolved.regionId) ?? ATOMIC_NOOP_LOAD_STORE;
  return atomicLoadBytesFromRegion({ destination, memory, address, byteLength });
};

/**
 * Atomic store of a naturally aligned 32-bit or 64-bit location from `source`.
 * Returns `false` when unmapped, non-RAM, or misaligned.
 * Always releases an SC-held monitor lock on every exit path.
 */
const atomicStoreBytes = ({
  memory,
  address,
  source,
  byteLength,
}: {
  memory: Memory;
  address: ReadonlyUint8Array;
  source: ReadonlyUint8Array;
  byteLength: 4 | 8;
}): boolean => {
  try {
    const resolved = resolveGuestAddressToRegionAndOffset(memory, address);
    if (resolved === null) {
      return false;
    }
    const [, atomicStoreBytesToRegion] =
      REGION_ATOMIC_LOAD_STORE.get(resolved.regionId) ?? ATOMIC_NOOP_LOAD_STORE;
    return atomicStoreBytesToRegion({ memory, address, source, byteLength });
  } finally {
    releaseScMonitorIfHeld(memory);
  }
};

/**
 * Atomic compare-and-swap of a naturally aligned 32-bit or 64-bit location.
 * Returns `false` when unmapped, non-RAM, misaligned, or the swap failed.
 */
const atomicCompareExchangeBytes = ({
  destination,
  memory,
  address,
  byteLength,
  expected,
  desired,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  byteLength: 4 | 8;
  expected: ReadonlyUint8Array;
  desired: ReadonlyUint8Array;
}): boolean => {
  const resolved = resolveGuestAddressToRegionAndOffset(memory, address);
  if (resolved === null) {
    return false;
  }
  const [, , atomicCompareExchangeBytesInRegion] =
    REGION_ATOMIC_LOAD_STORE.get(resolved.regionId) ?? ATOMIC_NOOP_LOAD_STORE;
  return atomicCompareExchangeBytesInRegion({
    destination,
    memory,
    address,
    byteLength,
    expected,
    desired,
  });
};

export {
  atomicCompareExchangeBytes,
  atomicLoadBytes,
  atomicStoreBytes,
  createMemory,
  loadBytes,
  storeBytes,
};
export type { Memory };
