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
 * RAM-only guest DMA for the virtio block engine.
 *
 * This helper exists to break an import cycle: `#emulator/memory` imports
 * `loadBytesFromVirtio` / `storeBytesToVirtio` from `#emulator/virtio`, so the block engine
 * must not import `#emulator/memory` at runtime. It therefore drives `#emulator/ram`
 * (leaf) directly and mirrors `memory.storeBytes`' reservation-monitor critical section
 * exactly. Never add a runtime `#emulator/memory` import here.
 *
 * Stores that fail (target outside the RAM window) do not write guest bytes; reads that
 * fail leave the destination untouched. Callers size the destination exactly. Only the
 * CPU worker calls these — the disk worker never touches guest RAM.
 */

import { RAM_REGION_ID, loadBytesFromRam, storeBytesToRam } from '#emulator/ram';
import {
  invalidateOverlappingReservationsLocked,
  releaseScMonitorIfHeld,
  withMonitorLock,
} from '#emulator/reservation';
import type { Memory } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';
import { bytesToBigInt } from '#utils/bytes';

/** Whole-transfer check: resolve `address` to a RAM window offset, or null. */
const guestRamOffset = (
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: number
): bigint | null => {
  const region = memory.regions.get(RAM_REGION_ID);
  if (region === undefined || region.guestAddress === null) {
    throw new Error(`Memory region '${RAM_REGION_ID}' is not packed.`);
  }
  const offset = bytesToBigInt(address) - bytesToBigInt(region.guestAddress);
  if (offset < 0n || offset + BigInt(byteLength) > region.guestByteLength) {
    return null; // whole access must sit inside the RAM guest window (no tail wrap)
  }
  return offset;
};

const loadGuestRamBytes = ({
  destination,
  memory,
  address,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  byteLength: number;
}): boolean => {
  const offset = guestRamOffset(memory, address, byteLength);
  if (offset === null) {
    return false;
  }
  loadBytesFromRam({ destination, memory, address, offset, byteLength });
  return true;
};

const storeGuestRamBytes = ({
  memory,
  address,
  source,
  byteLength,
}: {
  memory: Memory;
  address: ReadonlyUint8Array;
  source: ReadonlyUint8Array;
  byteLength: number;
}): boolean => {
  try {
    return withMonitorLock(memory, () => {
      // Same critical section as memory.storeBytes: invalidate before the write so a
      // remote hart cannot arm a reservation in the gap (AGENTS.md invariant 6).
      invalidateOverlappingReservationsLocked(memory, address, byteLength);
      const offset = guestRamOffset(memory, address, byteLength);
      if (offset === null) {
        return false;
      }
      storeBytesToRam({ memory, address, offset, source, byteLength });
      return true;
    });
  } finally {
    releaseScMonitorIfHeld(memory);
  }
};

export { loadGuestRamBytes, storeGuestRamBytes };
