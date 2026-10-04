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
 * RAM region — dense guestAddress ↔ hostIndex (entire slab is guest-addressable).
 */

import {
  bytesToBigInt,
  bytesToBigInt64Array,
  bytesToInt32Array,
  bytesToNumber,
  signedBytesToBigInt,
  signedNumberToBytes,
  unsignedBigIntToBytes,
} from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';
import { bigIntAsNumber } from '#utils/int';
import { invalidateOverlappingReservations, releaseScMonitorIfHeld } from '#emulator/reservation';
import type { Memory } from '#emulator/memory';

/** Packed-region id for DRAM (`createMemory` / `regions.get`). */
const RAM_REGION_ID = 'ram';

type RamRegion = Extract<
  NonNullable<ReturnType<Memory['regions']['get']>>,
  { guestAddress: ReadonlyUint8Array }
>;

const ramRegion = (memory: Memory): RamRegion => {
  const region = memory.regions.get(RAM_REGION_ID);
  if (region === undefined) {
    throw new Error(`Memory region '${RAM_REGION_ID}' is not packed.`);
  }
  if (region.guestAddress === null) {
    throw new Error(`Memory region '${RAM_REGION_ID}' is host-only; expected a guest window.`);
  }
  return region;
};

/**
 * Dense map: guest offset within the RAM window → absolute hostIndex, or `null`
 * when outside the addressable prefix.
 */
const denseGuestToHostIndex = (ram: RamRegion, guestOffset: bigint): bigint | null => {
  if (guestOffset < 0n || guestOffset >= ram.guestByteLength) {
    return null;
  }
  if (guestOffset >= ram.hostByteLength) {
    return null;
  }
  return ram.hostIndex + guestOffset;
};

/**
 * Map a guest RAM address to an absolute hostIndex, or `null` if outside the
 * RAM region's guest window.
 */
const ramAddressToHostIndex = (memory: Memory, address: ReadonlyUint8Array): bigint | null => {
  const ram = ramRegion(memory);
  const guestAddress = bytesToBigInt(address);
  const base = bytesToBigInt(ram.guestAddress);
  if (guestAddress < base || guestAddress >= base + ram.guestByteLength) {
    return null;
  }
  return denseGuestToHostIndex(ram, guestAddress - base);
};

/** Store a program image at the start of the packed RAM host slab. */
const storeImageToRam = (memory: Memory, image: ReadonlyUint8Array): void => {
  memory.bytes.set(image, bigIntAsNumber(ramRegion(memory).hostIndex));
};

const loadRamByte = (memory: Memory, hostIndex: bigint): number =>
  memory.bytes[bigIntAsNumber(hostIndex)] ?? 0;

const storeRamByte = (memory: Memory, hostIndex: bigint, value: number): void => {
  memory.bytes[bigIntAsNumber(hostIndex)] = value & 0xff;
};

/** Guest load of `byteLength` bytes from the RAM region at `offset`. */
const loadBytesFromRam = ({
  destination,
  memory,
  offset,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  byteLength: number;
}): void => {
  const ram = ramRegion(memory);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const hostIndex = denseGuestToHostIndex(ram, offset + BigInt(byteIndex));
    destination[byteIndex] = hostIndex === null ? 0 : loadRamByte(memory, hostIndex);
  }
};

/** Guest store of `byteLength` bytes into the RAM region at `offset`. */
const storeBytesToRam = ({
  memory,
  offset,
  source,
  byteLength,
}: {
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  source: ReadonlyUint8Array;
  byteLength: number;
}): void => {
  const ram = ramRegion(memory);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const hostIndex = denseGuestToHostIndex(ram, offset + BigInt(byteIndex));
    if (hostIndex !== null) {
      storeRamByte(memory, hostIndex, source[byteIndex] ?? 0);
    }
  }
};

const alignedRamAddressToHostIndex = (
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: 4 | 8
): bigint | null => {
  const hostIndex = ramAddressToHostIndex(memory, address);
  if (hostIndex === null) {
    return null;
  }
  const ram = ramRegion(memory);
  if (hostIndex + BigInt(byteLength) > ram.hostIndex + ram.hostByteLength) {
    return null;
  }
  if (hostIndex % BigInt(byteLength) !== 0n) {
    return null;
  }
  return hostIndex;
};

/**
 * Atomic load of a naturally aligned 32-bit or 64-bit RAM location into `destination`.
 * Returns `false` when outside RAM or misaligned.
 */
const atomicRamLoad = ({
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
  const hostIndex = alignedRamAddressToHostIndex(memory, address, byteLength);
  if (hostIndex === null) {
    return false;
  }
  destination.fill(0);
  if (byteLength === 4) {
    signedNumberToBytes(
      destination,
      Atomics.load(bytesToInt32Array(memory.bytes, bigIntAsNumber(hostIndex)), 0),
      32
    );
  } else {
    unsignedBigIntToBytes(
      destination,
      BigInt.asUintN(
        64,
        Atomics.load(bytesToBigInt64Array(memory.bytes, bigIntAsNumber(hostIndex)), 0)
      )
    );
  }
  return true;
};

/**
 * Atomic store of a naturally aligned 32-bit or 64-bit RAM location from `source`.
 * Returns `false` when outside RAM or misaligned. Invalidates overlapping reservations on success.
 */
const atomicRamStore = ({
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
  const hostIndex = alignedRamAddressToHostIndex(memory, address, byteLength);
  if (hostIndex === null) {
    return false;
  }
  try {
    if (byteLength === 4) {
      Atomics.store(
        bytesToInt32Array(memory.bytes, bigIntAsNumber(hostIndex)),
        0,
        bytesToNumber(source) | 0
      );
    } else {
      Atomics.store(
        bytesToBigInt64Array(memory.bytes, bigIntAsNumber(hostIndex)),
        0,
        signedBytesToBigInt(source)
      );
    }
    invalidateOverlappingReservations(memory, address, byteLength);
    return true;
  } finally {
    releaseScMonitorIfHeld(memory);
  }
};

/**
 * Atomic compare-and-swap of a naturally aligned 32-bit or 64-bit RAM location.
 * Writes the value observed in memory into `destination`. Returns `true` when the
 * swap succeeded (`destination` matched `expected`). Invalidates overlapping reservations on
 * success.
 * Returns `false` (without writing `destination`) when outside RAM or misaligned.
 */
const atomicRamCompareExchange = ({
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
  const hostIndex = alignedRamAddressToHostIndex(memory, address, byteLength);
  if (hostIndex === null) {
    return false;
  }
  destination.fill(0);
  if (byteLength === 4) {
    const view = bytesToInt32Array(memory.bytes, bigIntAsNumber(hostIndex));
    const expectedBits = bytesToNumber(expected) | 0;
    const previous = Atomics.compareExchange(view, 0, expectedBits, bytesToNumber(desired) | 0);
    signedNumberToBytes(destination, previous, 32);
    if (previous !== expectedBits) {
      return false;
    }
    invalidateOverlappingReservations(memory, address, byteLength);
    return true;
  }
  const view = bytesToBigInt64Array(memory.bytes, bigIntAsNumber(hostIndex));
  const expectedBits = signedBytesToBigInt(expected);
  const previous = Atomics.compareExchange(view, 0, expectedBits, signedBytesToBigInt(desired));
  unsignedBigIntToBytes(destination, BigInt.asUintN(64, previous));
  if (previous !== expectedBits) {
    return false;
  }
  invalidateOverlappingReservations(memory, address, byteLength);
  return true;
};

export {
  RAM_REGION_ID,
  atomicRamCompareExchange,
  atomicRamLoad,
  atomicRamStore,
  loadBytesFromRam,
  storeBytesToRam,
  storeImageToRam,
};
