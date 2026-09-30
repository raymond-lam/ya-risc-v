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

import { bytesToBigInt, bytesToBigUint64Array, bytesToInt32Array } from '#utils/bytes';
import { rangesOverlap } from '#utils/ranges';
import type { Memory } from '#emulator/memory/types';
import type { ReadonlyUint8Array } from '#types';

/**
 * Shared LR/SC monitor.
 *
 * Vocabulary:
 *   - **line** — guest-physical address granule (64 bytes). An `lr` reserves the line
 *     containing its address; a store that overlaps that line clears the claim.
 *   - **slot** — host SAB record for one hart (valid / width / LR address). Indexed by
 *     `mhartid`; not a guest address.
 *
 * Updates run under a SAB spinlock so clearing other harts / arming a slot is
 * transactional. A successful `tryTakeReservation` keeps the reservation held and
 * retains the monitor lock until the matching `storeBytes` / `atomicRamStore`
 * releases it (SC store window).
 */

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

/** Host bytes for the shared LR/SC monitor (lock + pad + slots). */
const RESERVATION_MONITOR_HOST_SIZE =
  RESERVATION_LOCK_BYTES + RESERVATION_LOCK_PAD + RESERVATION_HART_COUNT * RESERVATION_SLOT_SIZE;

/** Per-worker reentry depth for the monitor lock (SC holds across tryTake→store). */
let monitorLockDepth = 0;

/** True when this worker's successful tryTake still holds the lock for the SC store. */
let scMonitorHeld = false;

const reservationLockInt32 = (memory: Memory): Int32Array =>
  bytesToInt32Array(memory.bytes, memory.reservationMonitorHostIndex);

/** Guest-physical base of the reservation line that contains `guestAddress`. */
const reservationLineBase = (guestAddress: bigint): bigint =>
  guestAddress & ~(BigInt(RESERVATION_LINE_SIZE) - 1n);

/** Host byte index of hart `hartId`'s monitor slot. */
const reservationSlotHostIndex = (memory: Memory, hartId: number): number =>
  memory.reservationMonitorHostIndex +
  RESERVATION_LOCK_BYTES +
  RESERVATION_LOCK_PAD +
  hartId * RESERVATION_SLOT_SIZE;

const reservationSlotValidInt32 = (memory: Memory, hartId: number): Int32Array =>
  bytesToInt32Array(memory.bytes, reservationSlotHostIndex(memory, hartId));

const reservationSlotWidthInt32 = (memory: Memory, hartId: number): Int32Array =>
  bytesToInt32Array(memory.bytes, reservationSlotHostIndex(memory, hartId) + 4);

const reservationSlotAddressUint64 = (memory: Memory, hartId: number): BigUint64Array =>
  bytesToBigUint64Array(memory.bytes, reservationSlotHostIndex(memory, hartId) + 8);

const isValidHartId = (hartId: number): boolean =>
  Number.isInteger(hartId) && hartId >= 0 && hartId < RESERVATION_HART_COUNT;

const acquireMonitorLock = (memory: Memory): void => {
  if (monitorLockDepth > 0) {
    monitorLockDepth += 1;
    return;
  }
  const lock = reservationLockInt32(memory);
  for (;;) {
    if (Atomics.compareExchange(lock, 0, 0, 1) === 0) {
      monitorLockDepth = 1;
      return;
    }
    Atomics.wait(lock, 0, 1);
  }
};

const releaseMonitorLock = (memory: Memory): void => {
  if (monitorLockDepth <= 0) {
    return;
  }
  monitorLockDepth -= 1;
  if (monitorLockDepth > 0) {
    return;
  }
  const lock = reservationLockInt32(memory);
  Atomics.store(lock, 0, 0);
  Atomics.notify(lock, 0, 1);
};

/**
 * Release a monitor lock held across a successful SC `tryTakeReservation`.
 * Called at the end of `storeBytes` / `atomicRamStore`.
 */
const releaseScMonitorIfHeld = (memory: Memory): void => {
  if (!scMonitorHeld) {
    return;
  }
  scMonitorHeld = false;
  releaseMonitorLock(memory);
};

const withMonitorLock = <T>(memory: Memory, run: () => T): T => {
  acquireMonitorLock(memory);
  try {
    return run();
  } finally {
    releaseMonitorLock(memory);
  }
};

/** Clear hart `hartId`'s monitor slot (caller must hold the monitor lock). */
const clearReservationLocked = (memory: Memory, hartId: number): void => {
  Atomics.store(reservationSlotValidInt32(memory, hartId), 0, 0);
};

/** Clear hart `hartId`'s monitor slot. */
const clearReservation = (memory: Memory, hartId: number): void => {
  if (!isValidHartId(hartId)) {
    return;
  }
  withMonitorLock(memory, () => {
    clearReservationLocked(memory, hartId);
  });
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
 */
const setReservation = (
  memory: Memory,
  hartId: number,
  address: ReadonlyUint8Array,
  byteLength: number
): void => {
  if (!isValidHartId(hartId)) {
    return;
  }
  withMonitorLock(memory, () => {
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
  });
};

/**
 * If this hart's slot still matches, keep the reservation held and retain the monitor
 * lock until `releaseScMonitorIfHeld` (SC store path). Otherwise clear and return false.
 */
const tryTakeReservation = (
  memory: Memory,
  hartId: number,
  address: ReadonlyUint8Array,
  byteLength: number
): boolean => {
  if (!isValidHartId(hartId)) {
    return false;
  }
  acquireMonitorLock(memory);
  if (!reservationHoldsLocked(memory, hartId, address, byteLength)) {
    clearReservationLocked(memory, hartId);
    releaseMonitorLock(memory);
    return false;
  }
  // Keep valid=1 across the store; hold the lock so other harts cannot invalidate mid-window.
  scMonitorHeld = true;
  return true;
};

/**
 * Clear every slot whose reserved line overlaps `[address, address + byteLength)`.
 * Called on RAM stores and AMO writes so remote LR/SC observers see the invalidate.
 */
const invalidateOverlappingReservations = (
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: number
): void => {
  if (byteLength <= 0) {
    return;
  }
  withMonitorLock(memory, () => {
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
  });
};

export {
  RESERVATION_MONITOR_HOST_SIZE,
  setReservation,
  invalidateOverlappingReservations,
  releaseScMonitorIfHeld,
  tryTakeReservation,
};
