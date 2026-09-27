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
import { invalidateOverlappingReservations } from '#emulator/memory/reservation';
import type { Memory } from '#emulator/memory/types';

/**
 * Map a guest RAM address to a host index into `memory.bytes`, or `null` if the address
 * is outside the RAM window.
 */
const ramAddressToHostIndex = (memory: Memory, address: ReadonlyUint8Array): number | null => {
  const guestAddress = bytesToBigInt(address);
  const ramBase = bytesToBigInt(memory.ramBaseAddress);
  const ramEnd = ramBase + memory.ramSize;
  if (guestAddress >= ramBase && guestAddress < ramEnd) {
    return Number(guestAddress - ramBase);
  }
  return null;
};

const loadRamByte = (memory: Memory, hostIndex: number): number => memory.bytes[hostIndex] ?? 0;

const storeRamByte = (memory: Memory, hostIndex: number, value: number): void => {
  memory.bytes[hostIndex] = value & 0xff;
};

const alignedRamAddressToHostIndex = (
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: 4 | 8
): number | null => {
  const hostIndex = ramAddressToHostIndex(memory, address);
  if (hostIndex === null) {
    return null;
  }
  if (hostIndex + byteLength > Number(memory.ramSize) || hostIndex % byteLength !== 0) {
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
      Atomics.load(bytesToInt32Array(memory.bytes, hostIndex), 0),
      32
    );
  } else {
    unsignedBigIntToBytes(
      destination,
      BigInt.asUintN(64, Atomics.load(bytesToBigInt64Array(memory.bytes, hostIndex), 0))
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
  if (byteLength === 4) {
    Atomics.store(bytesToInt32Array(memory.bytes, hostIndex), 0, bytesToNumber(source) | 0);
  } else {
    Atomics.store(bytesToBigInt64Array(memory.bytes, hostIndex), 0, signedBytesToBigInt(source));
  }
  invalidateOverlappingReservations(memory, address, byteLength);
  return true;
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
    const view = bytesToInt32Array(memory.bytes, hostIndex);
    const expectedBits = bytesToNumber(expected) | 0;
    const previous = Atomics.compareExchange(view, 0, expectedBits, bytesToNumber(desired) | 0);
    signedNumberToBytes(destination, previous, 32);
    if (previous !== expectedBits) {
      return false;
    }
    invalidateOverlappingReservations(memory, address, byteLength);
    return true;
  }
  const view = bytesToBigInt64Array(memory.bytes, hostIndex);
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
  atomicRamCompareExchange,
  atomicRamLoad,
  atomicRamStore,
  loadRamByte,
  ramAddressToHostIndex,
  storeRamByte,
};
