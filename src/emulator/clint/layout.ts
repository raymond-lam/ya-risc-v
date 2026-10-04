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
 * CLINT guest-window / host-slab layout (no MMIO or timebase side effects).
 *
 * Guest (architectural offsets from the CLINT region's guestAddress; holes unmapped):
 *   +0x0000  msip (4 bytes; bit 0)
 *   +0x4000  mtimecmp (8 bytes)
 *   +0xbff8  mtime (8 bytes)
 *
 * Host slab (CLINT region's hostIndex, 32 bytes) — not a linear guest map:
 *   [mtime u64][mtimecmp u64][timerWire 1][softwareWire 1][pad 6][epochNs u64]
 */

import type { Memory } from '#emulator/memory';
import { bigIntAsNumber } from '#utils/int';

/** Packed-region id for the CLINT (`createMemory` / `regions.get`). */
const CLINT_REGION_ID = 'clint';

const CLINT_MSIP_OFFSET = 0x0n;
const CLINT_MTIMECMP_OFFSET = 0x4000n;
const CLINT_MTIME_OFFSET = 0xbff8n;
const CLINT_MSIP_SIZE = 4;
const CLINT_REGISTER_SIZE = 8;
/** Guest window size `[guestAddress, guestAddress + size)` (through mtime). */
const CLINT_GUEST_BYTE_LENGTH = 0xc000n;

const CLINT_HOST_MTIME_UINT64 = 0;
const CLINT_HOST_MTIMECMP_UINT64 = 1;
const CLINT_HOST_EPOCH_NS_UINT64 = 3;
const CLINT_HOST_UINT64_COUNT = 4;
/** Packed host slab size (time shadows + wires + epoch). */
const CLINT_HOST_BYTE_LENGTH = BigInt(CLINT_HOST_UINT64_COUNT * 8);
const CLINT_HOST_TIMER_WIRE_OFFSET = 16;
const CLINT_HOST_SOFTWARE_WIRE_OFFSET = 17;

type ClintTimeRegister = 'mtime' | 'mtimecmp';
type ClintRegister = 'msip' | ClintTimeRegister;

const clintRegion = (memory: Memory) => {
  const region = memory.regions.get(CLINT_REGION_ID);
  if (region === undefined) {
    throw new Error(`Memory region '${CLINT_REGION_ID}' is not packed.`);
  }
  if (region.guestAddress === null) {
    throw new Error(`Memory region '${CLINT_REGION_ID}' is host-only; expected a guest window.`);
  }
  return region;
};

/** TypedArray index of byte `offset` within the CLINT host slab. */
const clintByteIndex = (memory: Memory, offset: number): number =>
  bigIntAsNumber(clintRegion(memory).hostIndex + BigInt(offset));

/** Decode a guest offset within the CLINT window (holes → `null`). */
const clintOffsetToRegister = (
  offset: bigint
): { register: ClintRegister; byteOffset: number } | null => {
  if (offset >= CLINT_MSIP_OFFSET && offset < CLINT_MSIP_OFFSET + BigInt(CLINT_MSIP_SIZE)) {
    return { register: 'msip', byteOffset: Number(offset - CLINT_MSIP_OFFSET) };
  }
  if (offset >= CLINT_MTIME_OFFSET && offset < CLINT_MTIME_OFFSET + BigInt(CLINT_REGISTER_SIZE)) {
    return { register: 'mtime', byteOffset: Number(offset - CLINT_MTIME_OFFSET) };
  }
  if (
    offset >= CLINT_MTIMECMP_OFFSET &&
    offset < CLINT_MTIMECMP_OFFSET + BigInt(CLINT_REGISTER_SIZE)
  ) {
    return { register: 'mtimecmp', byteOffset: Number(offset - CLINT_MTIMECMP_OFFSET) };
  }
  return null;
};

/** `BigUint64Array` over the CLINT host slab (`mtime` / `mtimecmp` / pad / `epochNs`). */
const clintHostUint64s = (memory: Memory): BigUint64Array =>
  new BigUint64Array(
    memory.bytes.buffer,
    bigIntAsNumber(clintRegion(memory).hostIndex),
    CLINT_HOST_UINT64_COUNT
  );

export {
  CLINT_GUEST_BYTE_LENGTH,
  CLINT_HOST_BYTE_LENGTH,
  CLINT_HOST_EPOCH_NS_UINT64,
  CLINT_HOST_MTIMECMP_UINT64,
  CLINT_HOST_MTIME_UINT64,
  CLINT_HOST_SOFTWARE_WIRE_OFFSET,
  CLINT_HOST_TIMER_WIRE_OFFSET,
  CLINT_REGION_ID,
  CLINT_REGISTER_SIZE,
  clintByteIndex,
  clintHostUint64s,
  clintOffsetToRegister,
};
export type { ClintRegister, ClintTimeRegister };
