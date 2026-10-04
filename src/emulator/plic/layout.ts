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
 * PLIC guest-window / host-slab layout (no MMIO or gateway side effects).
 *
 * Guest (architectural offsets from the PLIC region's guestAddress; holes read 0 / ignore stores):
 *   priority[i]      @ +0x000000 + 4*i
 *   pending          @ +0x001000
 *   enable M / S     @ +0x002000 / +0x002080
 *   threshold/claim M@ +0x200000 / +0x200004
 *   threshold/claim S@ +0x201000 / +0x201004
 *
 * Host slab (PLIC region's hostIndex) — not a linear guest map:
 *   [priority×32 × 4][pending 4][enableM 4][enableS 4][thresholdM 4][thresholdS 4]
 *   [claimedByM 4][claimedByS 4][inputLevel 4][meipWire 1][seipWire 1][pad 2]
 *   [gatewayLock Int32]
 * claimed-by / inputLevel / wires / lock are host-only.
 */

import type { ReadonlyUint8Array } from '#types';
import type { Memory } from '#emulator/memory';
import { bytesToBigInt } from '#utils/bytes';
import { bigIntAsNumber } from '#utils/int';

/** Packed-region id for the PLIC (`createMemory` / `regions.get`). */
const PLIC_REGION_ID = 'plic';

const PLIC_PENDING_OFFSET = 0x1000n;
const PLIC_ENABLE_M_OFFSET = 0x2000n;
const PLIC_ENABLE_S_OFFSET = 0x2080n;
const PLIC_THRESHOLD_M_OFFSET = 0x200000n;
const PLIC_CLAIM_M_OFFSET = 0x200004n;
const PLIC_THRESHOLD_S_OFFSET = 0x201000n;
const PLIC_CLAIM_S_OFFSET = 0x201004n;
/** Guest window size used for overlap checks (through S claim/complete). */
const PLIC_GUEST_BYTE_LENGTH = 0x201008n;
const PLIC_MAX_SOURCE = 31;

const PLIC_HOST_PRIORITY_COUNT = 32;
const PLIC_HOST_PENDING = PLIC_HOST_PRIORITY_COUNT * 4;
const PLIC_HOST_ENABLE_M = PLIC_HOST_PENDING + 4;
const PLIC_HOST_ENABLE_S = PLIC_HOST_ENABLE_M + 4;
const PLIC_HOST_THRESHOLD_M = PLIC_HOST_ENABLE_S + 4;
const PLIC_HOST_THRESHOLD_S = PLIC_HOST_THRESHOLD_M + 4;
const PLIC_HOST_CLAIMED_BY_M = PLIC_HOST_THRESHOLD_S + 4;
const PLIC_HOST_CLAIMED_BY_S = PLIC_HOST_CLAIMED_BY_M + 4;
const PLIC_HOST_INPUT_LEVEL = PLIC_HOST_CLAIMED_BY_S + 4;
const PLIC_HOST_MEIP_WIRE_OFFSET = PLIC_HOST_INPUT_LEVEL + 4;
const PLIC_HOST_SEIP_WIRE_OFFSET = PLIC_HOST_MEIP_WIRE_OFFSET + 1;
/** Int32 gateway monitor (0 = free, 1 = held); after wires + 2-byte pad. */
const PLIC_HOST_GATEWAY_LOCK = PLIC_HOST_MEIP_WIRE_OFFSET + 4;
/** Packed host slab size. */
const PLIC_HOST_BYTE_LENGTH = BigInt(PLIC_HOST_GATEWAY_LOCK + 4);

/** UART external interrupt identity (source 10). */
const PLIC_SOURCE_UART = 10;

type PlicContext = 'machine' | 'supervisor';

type PlicLocation =
  | { kind: 'priority'; source: number; byteOffset: number }
  | { kind: 'pending'; byteOffset: number }
  | { kind: 'enable'; context: PlicContext; byteOffset: number }
  | { kind: 'threshold'; context: PlicContext; byteOffset: number }
  | { kind: 'claim'; context: PlicContext; byteOffset: number };

const plicRegion = (memory: Memory) => {
  const region = memory.regions.get(PLIC_REGION_ID);
  if (region === undefined) {
    throw new Error(`Memory region '${PLIC_REGION_ID}' is not packed.`);
  }
  if (region.guestAddress === null) {
    throw new Error(`Memory region '${PLIC_REGION_ID}' is host-only; expected a guest window.`);
  }
  return region;
};

const isValidSource = (source: number): boolean => source >= 1 && source <= PLIC_MAX_SOURCE;

const enableHostOffset = (context: PlicContext): number =>
  context === 'machine' ? PLIC_HOST_ENABLE_M : PLIC_HOST_ENABLE_S;

const thresholdHostOffset = (context: PlicContext): number =>
  context === 'machine' ? PLIC_HOST_THRESHOLD_M : PLIC_HOST_THRESHOLD_S;

const claimedByHostOffset = (context: PlicContext): number =>
  context === 'machine' ? PLIC_HOST_CLAIMED_BY_M : PLIC_HOST_CLAIMED_BY_S;

const contextWireOffset = (context: PlicContext): number =>
  context === 'machine' ? PLIC_HOST_MEIP_WIRE_OFFSET : PLIC_HOST_SEIP_WIRE_OFFSET;

/** TypedArray index of byte `offset` within the PLIC host slab. */
const plicHostIndex = (memory: Memory, offset: number): number =>
  bigIntAsNumber(plicRegion(memory).hostIndex + BigInt(offset));

const plicHostIndexForLocation = (
  memory: Memory,
  location: Exclude<PlicLocation, { kind: 'claim' }>
): number => {
  switch (location.kind) {
    case 'priority':
      return plicHostIndex(memory, location.source * 4 + location.byteOffset);
    case 'pending':
      return plicHostIndex(memory, PLIC_HOST_PENDING + location.byteOffset);
    case 'enable':
      return plicHostIndex(memory, enableHostOffset(location.context) + location.byteOffset);
    case 'threshold':
      return plicHostIndex(memory, thresholdHostOffset(location.context) + location.byteOffset);
  }
};

/** Decode a guest offset within the PLIC window (holes → `null`). */
const plicOffsetToLocation = (offset: bigint): PlicLocation | null => {
  if (offset < 0n || offset >= PLIC_GUEST_BYTE_LENGTH) {
    return null;
  }

  if (offset < BigInt(PLIC_HOST_PRIORITY_COUNT * 4)) {
    const relative = Number(offset);
    return { kind: 'priority', source: relative >> 2, byteOffset: relative & 3 };
  }

  const registerOffset = offset & ~3n;
  const byteOffset = Number(offset & 3n);
  switch (registerOffset) {
    case PLIC_PENDING_OFFSET:
      return { kind: 'pending', byteOffset };
    case PLIC_ENABLE_M_OFFSET:
      return { kind: 'enable', context: 'machine', byteOffset };
    case PLIC_ENABLE_S_OFFSET:
      return { kind: 'enable', context: 'supervisor', byteOffset };
    case PLIC_THRESHOLD_M_OFFSET:
      return { kind: 'threshold', context: 'machine', byteOffset };
    case PLIC_CLAIM_M_OFFSET:
      return { kind: 'claim', context: 'machine', byteOffset };
    case PLIC_THRESHOLD_S_OFFSET:
      return { kind: 'threshold', context: 'supervisor', byteOffset };
    case PLIC_CLAIM_S_OFFSET:
      return { kind: 'claim', context: 'supervisor', byteOffset };
    default:
      return null;
  }
};

const plicAddressToLocation = (
  memory: Memory,
  address: ReadonlyUint8Array
): PlicLocation | null => {
  const region = plicRegion(memory);
  const offset = bytesToBigInt(address) - bytesToBigInt(region.guestAddress);
  return plicOffsetToLocation(offset);
};

export {
  PLIC_GUEST_BYTE_LENGTH,
  PLIC_HOST_BYTE_LENGTH,
  PLIC_HOST_CLAIMED_BY_M,
  PLIC_HOST_CLAIMED_BY_S,
  PLIC_HOST_GATEWAY_LOCK,
  PLIC_HOST_INPUT_LEVEL,
  PLIC_HOST_MEIP_WIRE_OFFSET,
  PLIC_HOST_PENDING,
  PLIC_HOST_SEIP_WIRE_OFFSET,
  PLIC_MAX_SOURCE,
  PLIC_REGION_ID,
  PLIC_SOURCE_UART,
  claimedByHostOffset,
  contextWireOffset,
  enableHostOffset,
  isValidSource,
  plicAddressToLocation,
  plicHostIndex,
  plicHostIndexForLocation,
  plicRegion,
  thresholdHostOffset,
};
export type { PlicContext };
