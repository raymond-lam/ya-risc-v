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
 * Reservation-monitor region — host-only LR/SC state (no guestAddress).
 *
 * Vocabulary:
 *   - **line** — guest-physical address granule (64 bytes). An `lr` reserves the line
 *     containing its address; a store that overlaps that line clears the claim.
 *   - **slot** — host SAB record for one hart (valid / width / LR address). Indexed by
 *     `mhartid`; not a guest address.
 *
 * Updates run under a SAB lock. SC checks and stores in one synchronous critical
 * section; plain stores and AMOs hold the lock across invalidation and the write.
 */

import { bytesToBigInt, bytesToBigUint64Array, bytesToInt32Array } from '#utils/bytes';
import { rangesOverlap } from '#utils/ranges';
import { bigIntAsNumber } from '#utils/int';
import type { Memory } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';

/** Packed-region id for the LR/SC monitor (`createMemory` / `regions.get`). */
const RESERVATION_REGION_ID = 'reservation';

/** Bytes in one reservation line (guest address granule). */
const RESERVATION_LINE_SIZE = 64;

/** Number of per-hart slots in the monitor. */
const RESERVATION_HART_COUNT = 8;

/**
 * Host bytes in one slot (8-byte aligned):
 *   [0..3]  valid Int32 (0/1)
 *   [4..7]  reserved width in bytes (Int32; 4 or 8)
 *   [8..15] guest physical LR address (BigUint64)
 */
const RESERVATION_SLOT_SIZE = 16;

/** Host Int32 lock at the monitor base (0 = free, 1 = held). */
const RESERVATION_LOCK_BYTES = 4;
/** Pad so slots stay 8-byte aligned after the lock. */
const RESERVATION_LOCK_PAD = 4;

/** Host slab size (lock + pad + slots). */
const RESERVATION_HOST_BYTE_LENGTH = BigInt(
  RESERVATION_LOCK_BYTES + RESERVATION_LOCK_PAD + RESERVATION_HART_COUNT * RESERVATION_SLOT_SIZE
);

const reservationRegion = (memory: Memory) => {
  const region = memory.regions.get(RESERVATION_REGION_ID);
  if (region === undefined) {
    throw new Error(`Memory region '${RESERVATION_REGION_ID}' is not packed.`);
  }
  if (region.guestAddress !== null) {
    throw new Error(
      `Memory region '${RESERVATION_REGION_ID}' is guest-mapped; expected host-only.`
    );
  }
  return region;
};

const reservationLockIndex = (memory: Memory): number =>
  bigIntAsNumber(reservationRegion(memory).hostIndex);

/** Guest-physical base of the reservation line that contains `guestAddress`. */
const reservationLineBase = (guestAddress: bigint): bigint =>
  guestAddress & ~(BigInt(RESERVATION_LINE_SIZE) - 1n);

/** Absolute hostIndex of hart `hartId`'s monitor slot. */
const reservationSlotHostIndex = (memory: Memory, hartId: number): bigint =>
  reservationRegion(memory).hostIndex +
  BigInt(RESERVATION_LOCK_BYTES + RESERVATION_LOCK_PAD + hartId * RESERVATION_SLOT_SIZE);

const reservationSlotValidInt32 = (memory: Memory, hartId: number): Int32Array =>
  bytesToInt32Array(memory.bytes, bigIntAsNumber(reservationSlotHostIndex(memory, hartId)));

const reservationSlotWidthInt32 = (memory: Memory, hartId: number): Int32Array =>
  bytesToInt32Array(memory.bytes, bigIntAsNumber(reservationSlotHostIndex(memory, hartId) + 4n));

const reservationSlotAddressUint64 = (memory: Memory, hartId: number): BigUint64Array =>
  bytesToBigUint64Array(
    memory.bytes,
    bigIntAsNumber(reservationSlotHostIndex(memory, hartId) + 8n)
  );

const isValidHartId = (hartId: number): boolean =>
  Number.isInteger(hartId) && hartId >= 0 && hartId < RESERVATION_HART_COUNT;

/** Clear hart `hartId`'s monitor slot (caller must hold the monitor lock). */
const clearReservationLocked = (memory: Memory, hartId: number): void => {
  Atomics.store(reservationSlotValidInt32(memory, hartId), 0, 0);
};

/**
 * True when hart `hartId`'s slot still holds a reservation for exact `address` / `byteLength`.
 * Caller must hold the monitor lock.
 */
const reservationHoldsLocked = (
  memory: Memory,
  hartId: number,
  address: ReadonlyUint8Array,
  byteLength: number
): boolean => {
  if (Atomics.load(reservationSlotValidInt32(memory, hartId), 0) === 0) {
    return false;
  }
  if (Atomics.load(reservationSlotWidthInt32(memory, hartId), 0) !== byteLength) {
    return false;
  }
  return Atomics.load(reservationSlotAddressUint64(memory, hartId), 0) === bytesToBigInt(address);
};

/**
 * Arm hart `hartId`'s slot for exact `address` / `byteLength`.
 * Clears any other hart's slot whose reserved line matches (single owner per line).
 * Caller must hold the monitor lock.
 */
const setReservationLocked = (
  memory: Memory,
  hartId: number,
  address: ReadonlyUint8Array,
  byteLength: number
): void => {
  if (!isValidHartId(hartId)) {
    return;
  }
  const guestAddress = bytesToBigInt(address);
  const lineBase = reservationLineBase(guestAddress);
  for (let otherHartId = 0; otherHartId < RESERVATION_HART_COUNT; otherHartId += 1) {
    if (otherHartId === hartId) {
      continue;
    }
    if (Atomics.load(reservationSlotValidInt32(memory, otherHartId), 0) === 0) {
      continue;
    }
    const otherAddress = Atomics.load(reservationSlotAddressUint64(memory, otherHartId), 0);
    if (reservationLineBase(otherAddress) === lineBase) {
      clearReservationLocked(memory, otherHartId);
    }
  }
  Atomics.store(reservationSlotAddressUint64(memory, hartId), 0, guestAddress);
  Atomics.store(reservationSlotWidthInt32(memory, hartId), 0, byteLength);
  Atomics.store(reservationSlotValidInt32(memory, hartId), 0, 1);
};

/** Consume the hart's reservation on every SC attempt; caller holds the monitor. */
const tryTakeReservation = (
  memory: Memory,
  hartId: number,
  address: ReadonlyUint8Array,
  byteLength: number
): boolean => {
  if (!isValidHartId(hartId)) {
    return false;
  }
  const matches = reservationHoldsLocked(memory, hartId, address, byteLength);
  clearReservationLocked(memory, hartId);
  return matches;
};

/**
 * Clear every slot whose reserved line overlaps `[address, address + byteLength)`.
 * Caller must hold the monitor lock.
 */
const invalidateOverlappingReservationsLocked = (
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: number
): void => {
  if (byteLength <= 0) {
    return;
  }
  const storeBase = bytesToBigInt(address);
  const storeSize = BigInt(byteLength);
  for (let hartId = 0; hartId < RESERVATION_HART_COUNT; hartId += 1) {
    if (Atomics.load(reservationSlotValidInt32(memory, hartId), 0) === 0) {
      continue;
    }
    const reservedAddress = Atomics.load(reservationSlotAddressUint64(memory, hartId), 0);
    const lineBase = reservationLineBase(reservedAddress);
    if (rangesOverlap(lineBase, BigInt(RESERVATION_LINE_SIZE), storeBase, storeSize)) {
      clearReservationLocked(memory, hartId);
    }
  }
};

export {
  RESERVATION_HOST_BYTE_LENGTH,
  RESERVATION_REGION_ID,
  invalidateOverlappingReservationsLocked,
  reservationLockIndex,
  setReservationLocked,
  tryTakeReservation,
};
