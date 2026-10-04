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
 * PLIC region — sparse guest window, packed host slab.
 *
 * Guest (architectural offsets from the PLIC region's guestAddress; holes read 0 / ignore stores):
 *   priority[i]      @ +0x000000 + 4*i
 *   pending          @ +0x001000
 *   enable M / S     @ +0x002000 / +0x002080
 *   threshold/claim M@ +0x200000 / +0x200004
 *   threshold/claim S@ +0x201000 / +0x201004
 *
 * Host slab (PLIC region's hostIndex, 160 bytes) — not a linear guest map:
 *   [priority×32 × 4][pending 4][enableM 4][enableS 4][thresholdM 4][thresholdS 4]
 *   [claimed 4][inputLevel 4][meipWire 1][seipWire 1][pad 2]
 * claimed / inputLevel / wires are host-only.
 */

import { addBytes, bytesToBigInt, copyBytes, signedNumberToBytes } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';
import { atomicLoad32, atomicLoadBit, atomicUpdateBit } from '#utils/atomics';
import { bigIntAsNumber } from '#utils/int';
import { setIrqWire, IRQ_LEVEL_MEIP, IRQ_LEVEL_SEIP } from '#emulator/irq-level';
import type { Memory } from '#emulator/memory';

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
const PLIC_HOST_CLAIMED = PLIC_HOST_THRESHOLD_S + 4;
const PLIC_HOST_INPUT_LEVEL = PLIC_HOST_CLAIMED + 4;
const PLIC_HOST_MEIP_WIRE_OFFSET = PLIC_HOST_INPUT_LEVEL + 4;
const PLIC_HOST_SEIP_WIRE_OFFSET = PLIC_HOST_MEIP_WIRE_OFFSET + 1;
/** Packed host slab size. */
const PLIC_HOST_BYTE_LENGTH = BigInt(PLIC_HOST_MEIP_WIRE_OFFSET + 4);

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

const contextWireOffset = (context: PlicContext): number =>
  context === 'machine' ? PLIC_HOST_MEIP_WIRE_OFFSET : PLIC_HOST_SEIP_WIRE_OFFSET;

const plicHostIndex = (memory: Memory, offset: number): number =>
  bigIntAsNumber(plicRegion(memory).hostIndex + BigInt(offset));

/** Absolute `memory.bytes` index of the byte holding `source`'s bit in the bitfield at `hostOffset`. */
const plicHostIndexForSourceBit = (memory: Memory, hostOffset: number, source: number): number =>
  plicHostIndex(memory, hostOffset) + (source >> 3);

const updateSourceBit = (
  memory: Memory,
  hostOffset: number,
  source: number,
  value: boolean
): void => {
  atomicUpdateBit({
    bytes: memory.bytes,
    index: plicHostIndexForSourceBit(memory, hostOffset, source),
    bit: source & 7,
    value,
  });
};

const isSourceBitSet = (memory: Memory, hostOffset: number, source: number): boolean =>
  atomicLoadBit({
    bytes: memory.bytes,
    index: plicHostIndexForSourceBit(memory, hostOffset, source),
    bit: source & 7,
  });

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

/** Drive a level-sensitive PLIC→hart wire and publish into the irq-level word. */
const setPlicContextWire = (memory: Memory, context: PlicContext, pending: boolean): void => {
  setIrqWire(
    memory,
    plicHostIndex(memory, contextWireOffset(context)),
    pending,
    context === 'machine' ? IRQ_LEVEL_MEIP : IRQ_LEVEL_SEIP
  );
};

/**
 * Highest-priority pending∧enabled source above `threshold`, or 0.
 * Tie-break: lowest source id wins. Reads host shadows (not guest MMIO).
 */
const selectClaimableSource = (memory: Memory, context: PlicContext): number => {
  const enableOffset = enableHostOffset(context);
  const threshold = atomicLoad32({
    bytes: memory.bytes,
    index: plicHostIndex(memory, thresholdHostOffset(context)),
  });
  let bestSource = 0;
  let bestPriority = 0;
  for (let source = 1; source <= PLIC_MAX_SOURCE; source += 1) {
    if (
      !isSourceBitSet(memory, PLIC_HOST_PENDING, source) ||
      !isSourceBitSet(memory, enableOffset, source)
    ) {
      continue;
    }
    const priority = atomicLoad32({
      bytes: memory.bytes,
      index: plicHostIndex(memory, source * 4),
    });
    if (priority <= threshold) {
      continue;
    }
    if (
      bestSource === 0 ||
      priority > bestPriority ||
      (priority === bestPriority && source < bestSource)
    ) {
      bestPriority = priority;
      bestSource = source;
    }
  }
  return bestSource;
};

const refreshContextWire = (memory: Memory, context: PlicContext): void => {
  setPlicContextWire(memory, context, selectClaimableSource(memory, context) !== 0);
};

const refreshAllContextWires = (memory: Memory): void => {
  refreshContextWire(memory, 'machine');
  refreshContextWire(memory, 'supervisor');
};

/** UART external interrupt identity (source 10). */
const PLIC_SOURCE_UART = 10;

/**
 * Device-driven input level for `source` (1..31). Updates guest-visible pending
 * through the claim gateway, then refreshes M/S context wires.
 */
const setPlicSourcePending = (memory: Memory, source: number, pending: boolean): void => {
  if (!isValidSource(source)) {
    return;
  }
  updateSourceBit(memory, PLIC_HOST_INPUT_LEVEL, source, pending);
  if (!pending) {
    updateSourceBit(memory, PLIC_HOST_PENDING, source, false);
  } else if (!isSourceBitSet(memory, PLIC_HOST_CLAIMED, source)) {
    updateSourceBit(memory, PLIC_HOST_PENDING, source, true);
  }
  refreshAllContextWires(memory);
};

/** Claim: return id and clear global pending; mark gateway claimed. */
const claimPlicSource = (memory: Memory, context: PlicContext): number => {
  const source = selectClaimableSource(memory, context);
  if (source !== 0) {
    updateSourceBit(memory, PLIC_HOST_PENDING, source, false);
    updateSourceBit(memory, PLIC_HOST_CLAIMED, source, true);
  }
  refreshAllContextWires(memory);
  return source;
};

/** Complete: release gateway; re-pending when the device input level is still high. */
const completePlicSource = (memory: Memory, source: number): void => {
  if (!isValidSource(source)) {
    return;
  }
  updateSourceBit(memory, PLIC_HOST_CLAIMED, source, false);
  if (isSourceBitSet(memory, PLIC_HOST_INPUT_LEVEL, source)) {
    updateSourceBit(memory, PLIC_HOST_PENDING, source, true);
  }
  refreshAllContextWires(memory);
};

/** Load one guest PLIC byte at `address`. Claim side-effects on the low byte only. */
const loadPlicByte = (memory: Memory, address: ReadonlyUint8Array): number => {
  const location = plicAddressToLocation(memory, address);
  if (location === null) {
    return 0;
  }
  if (location.kind === 'claim') {
    // Side effect once on the low byte (little-endian `lw` hits byte 0 first). Ids ≤ 31.
    if (location.byteOffset !== 0) {
      return 0;
    }
    return claimPlicSource(memory, location.context) & 0xff;
  }
  if (location.kind === 'priority' && location.source === 0) {
    return 0;
  }
  return Atomics.load(memory.bytes, plicHostIndexForLocation(memory, location));
};

/** Store one guest PLIC byte at `address`. Pending is device-driven (stores ignored). */
const storePlicByte = (memory: Memory, address: ReadonlyUint8Array, value: number): void => {
  const location = plicAddressToLocation(memory, address);
  if (location === null) {
    return;
  }
  const byte = value & 0xff;
  switch (location.kind) {
    case 'priority':
      if (location.source === 0) {
        return;
      }
      Atomics.store(memory.bytes, plicHostIndexForLocation(memory, location), byte);
      refreshAllContextWires(memory);
      return;
    case 'pending':
      return;
    case 'enable': {
      const index = plicHostIndexForLocation(memory, location);
      // Source 0 enable bit is reserved; clear it when writing byte 0.
      Atomics.store(memory.bytes, index, location.byteOffset === 0 ? byte & ~1 : byte);
      refreshContextWire(memory, location.context);
      return;
    }
    case 'threshold':
      Atomics.store(memory.bytes, plicHostIndexForLocation(memory, location), byte);
      refreshContextWire(memory, location.context);
      return;
    case 'claim': {
      // Guests store a full u32; accept the low byte as the source id (sources are ≤ 31).
      if (location.byteOffset !== 0 || !isValidSource(byte)) {
        return;
      }
      completePlicSource(memory, byte);
      return;
    }
  }
};

/** Level of the PLIC machine-external wire (sampled into `mip.MEIP`). */
const isPlicMachineExternalPending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, plicHostIndex(memory, PLIC_HOST_MEIP_WIRE_OFFSET)) !== 0;

/** Level of the PLIC supervisor-external wire (sampled into `mip.SEIP`). */
const isPlicSupervisorExternalPending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, plicHostIndex(memory, PLIC_HOST_SEIP_WIRE_OFFSET)) !== 0;

/** Initialize PLIC shadows: priorities/enables/thresholds/claimed clear; wires low. */
const initializePlic = (memory: Memory): void => {
  const base = bigIntAsNumber(plicRegion(memory).hostIndex);
  memory.bytes.fill(0, base, base + PLIC_HOST_MEIP_WIRE_OFFSET);
  setPlicContextWire(memory, 'machine', false);
  setPlicContextWire(memory, 'supervisor', false);
};

const ONE_BYTE = signedNumberToBytes(new Uint8Array(8), 1, 32) as ReadonlyUint8Array;

/** Guest load of `byteLength` PLIC bytes starting at `address` / window `offset`. */
const loadBytesFromPlic = ({
  destination,
  memory,
  address,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  byteLength: number;
}): void => {
  const addressCursor = copyBytes(new Uint8Array(8), address);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    destination[byteIndex] = loadPlicByte(memory, addressCursor);
    addBytes(addressCursor, addressCursor, ONE_BYTE);
  }
};

/** Guest store of `byteLength` PLIC bytes starting at `address` / window `offset`. */
const storeBytesToPlic = ({
  memory,
  address,
  source,
  byteLength,
}: {
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  source: ReadonlyUint8Array;
  byteLength: number;
}): void => {
  const addressCursor = copyBytes(new Uint8Array(8), address);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    storePlicByte(memory, addressCursor, source[byteIndex] ?? 0);
    addBytes(addressCursor, addressCursor, ONE_BYTE);
  }
};

export {
  PLIC_GUEST_BYTE_LENGTH,
  PLIC_HOST_BYTE_LENGTH,
  PLIC_REGION_ID,
  PLIC_SOURCE_UART,
  initializePlic,
  isPlicMachineExternalPending,
  isPlicSupervisorExternalPending,
  loadBytesFromPlic,
  setPlicSourcePending,
  storeBytesToPlic,
};
