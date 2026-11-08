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

/** Dense RAM accessed as aligned 64-bit words. Startup copies precede all workers.
 * Runtime subword updates CAS only requested bytes; bulk DMA spans individually visible
 * words. All writers invalidate their logical span under the reservation monitor. */

import { bytesToAlignedBigUint64Array, bytesToBigInt, unsignedBigIntToBytes } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';
import { bigIntAsNumber } from '#utils/int';
import { invalidateOverlappingReservationsLocked } from '#emulator/reservation';
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
 * Whole-transfer check: the offset of `address` inside the RAM guest window, or `null`
 * when `[address, address + byteLength)` is not wholly inside it (no tail wrap).
 * Guest DMA passes the real transfer length; single-address callers pass `0`.
 */
const guestRamOffset = (
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: number
): bigint | null => {
  const ram = ramRegion(memory);
  const offset = bytesToBigInt(address) - bytesToBigInt(ram.guestAddress);
  if (offset < 0n || offset + BigInt(byteLength) > ram.guestByteLength) {
    return null;
  }
  return offset;
};

/**
 * Map a guest RAM address to an absolute hostIndex, or `null` if outside the
 * RAM region's guest window.
 */
const ramAddressToHostIndex = (memory: Memory, address: ReadonlyUint8Array): bigint | null => {
  const offset = guestRamOffset(memory, address, 0); // 0-byte span: just the address must be in-window
  return offset === null ? null : denseGuestToHostIndex(ramRegion(memory), offset);
};

/** Store a program image at the start of the packed RAM host slab. */
const storeImageToRam = (memory: Memory, image: ReadonlyUint8Array): void => {
  memory.bytes.set(image, bigIntAsNumber(ramRegion(memory).hostIndex));
};

/** Copy `source` into the packed RAM host slab at guest `address`. */
const copyIntoRam = (
  memory: Memory,
  address: ReadonlyUint8Array,
  source: ReadonlyUint8Array
): void => {
  const hostIndex = ramAddressToHostIndex(memory, address);
  const ram = ramRegion(memory);
  if (
    hostIndex === null ||
    hostIndex + BigInt(source.length) > ram.hostIndex + ram.hostByteLength
  ) {
    throw new RangeError('Copy exceeds the ram region.');
  }
  memory.bytes.set(source, bigIntAsNumber(hostIndex));
};

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
  let copied = 0;
  while (copied < byteLength) {
    const position = offset + BigInt(copied);
    if (position < 0n || position >= ram.guestByteLength) {
      destination[copied++] = 0;
      continue;
    }
    const [view, within] = bytesToAlignedBigUint64Array(
      memory.bytes,
      bigIntAsNumber(ram.hostIndex + position)
    );
    const length = Math.min(
      8 - within,
      byteLength - copied,
      Number(ram.guestByteLength - position)
    );
    const bytes = unsignedBigIntToBytes(new Uint8Array(8), Atomics.load(view, 0));
    destination.set(bytes.subarray(within, within + length), copied);
    copied += length;
  }
};
const storeBytesToRam = ({
  memory,
  address,
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
  invalidateOverlappingReservationsLocked(memory, address, byteLength);
  let copied = 0;
  while (copied < byteLength) {
    const position = offset + BigInt(copied);
    if (position < 0n || position >= ram.guestByteLength) {
      copied++;
      continue;
    }
    const [view, within] = bytesToAlignedBigUint64Array(
      memory.bytes,
      bigIntAsNumber(ram.hostIndex + position)
    );
    const length = Math.min(
      8 - within,
      byteLength - copied,
      Number(ram.guestByteLength - position)
    );
    let previous = Atomics.load(view, 0);
    for (;;) {
      const bytes = unsignedBigIntToBytes(new Uint8Array(8), previous);
      for (let i = 0; i < length; i++) bytes[within + i] = source[copied + i] ?? 0;
      const observed = Atomics.compareExchange(view, 0, previous, bytesToBigInt(bytes));
      if (observed === previous) break;
      previous = observed;
    }
    copied += length;
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
  if (
    hostIndex + BigInt(byteLength) > ram.hostIndex + ram.guestByteLength ||
    hostIndex + BigInt(byteLength) > ram.hostIndex + ram.hostByteLength
  ) {
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
  loadBytesFromRam({
    destination,
    memory,
    address,
    offset: hostIndex - ramRegion(memory).hostIndex,
    byteLength,
  });
  return true;
};

/**
 * Atomic store of a naturally aligned 32-bit or 64-bit RAM location from `source`.
 * Returns `false` when outside RAM or misaligned. Invalidates overlapping reservations
 * in the same critical section as the write. Caller holds the reservation monitor.
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
  storeBytesToRam({
    memory,
    address,
    source,
    offset: hostIndex - ramRegion(memory).hostIndex,
    byteLength,
  });
  return true;
};

/**
 * Atomic compare-and-swap of a naturally aligned 32-bit or 64-bit RAM location.
 * Writes the value observed in memory into `destination`. Returns `true` when the
 * swap succeeded (`destination` matched `expected`). Invalidates overlapping reservations
 * in the same critical section as a successful write.
 * Returns `false` (without writing `destination`) when outside RAM or misaligned.
 * Caller holds the reservation monitor.
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
  loadBytesFromRam({
    destination,
    memory,
    address,
    offset: hostIndex - ramRegion(memory).hostIndex,
    byteLength,
  });
  for (let i = 0; i < byteLength; i++) {
    if (destination[i] !== (expected[i] ?? 0)) return false;
  }
  // All RAM writers hold the reservation monitor; comparison and subword CAS remain
  // one logical AMO transaction, using the same aligned 64-bit words as ordinary DMA.
  storeBytesToRam({
    memory,
    address,
    source: desired,
    offset: hostIndex - ramRegion(memory).hostIndex,
    byteLength,
  });
  return true;
};

export {
  RAM_REGION_ID,
  atomicRamCompareExchange,
  atomicRamLoad,
  atomicRamStore,
  loadBytesFromRam,
  copyIntoRam,
  guestRamOffset,
  storeBytesToRam,
  storeImageToRam,
};
