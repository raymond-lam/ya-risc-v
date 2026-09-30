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

import { bytesToBigInt, bytesToNumber, unsignedNumberToBytes } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';
import {
  atomicLoad32,
  atomicLoadBit,
  atomicStore32,
  atomicUpdateBit,
} from '#emulator/memory/atomics';
import { setIrqWire, IRQ_LEVEL_MEIP, IRQ_LEVEL_SEIP } from '#emulator/memory/hart-wake';
import type { Memory } from '#emulator/memory/types';

/**
 * Minimal platform-level interrupt controller (single hart, M + S contexts):
 *   priority[i]     @ +0x000000 + 4*i   (i = 1..31; source 0 reserved)
 *   pending[31:0]   @ +0x001000         (read-only; driven by source wires)
 *   enable M        @ +0x002000
 *   enable S        @ +0x002080
 *   threshold M     @ +0x200000
 *   claim/complete M@ +0x200004
 *   threshold S     @ +0x201000
 *   claim/complete S@ +0x201004
 *
 * UART IRQ line is source 10. Guest holes in the window read as 0 / ignore stores.
 *
 * Claim clears the global pending bit (SiFive/QEMU). A per-source gateway
 * (`claimed`) suppresses re-pending until complete; complete re-arms when the
 * device input level is still high.
 */
const PLIC_PENDING_OFFSET = 0x1000n;
const PLIC_ENABLE_M_OFFSET = 0x2000n;
const PLIC_ENABLE_S_OFFSET = 0x2080n;
const PLIC_THRESHOLD_M_OFFSET = 0x200000n;
const PLIC_CLAIM_M_OFFSET = 0x200004n;
const PLIC_THRESHOLD_S_OFFSET = 0x201000n;
const PLIC_CLAIM_S_OFFSET = 0x201004n;
/** Guest window size used for overlap checks (through S claim/complete). */
const PLIC_WINDOW_SIZE = 0x201008n;
const PLIC_MAX_SOURCE = 31;

/**
 * Host packing (byte Atomics on bitfields/wires; Int32 u32 loads for priority/threshold):
 *   [priority×32 × 4][pending 4][enableM 4][enableS 4][thresholdM 4][thresholdS 4]
 *   [claimed 4][inputLevel 4][meipWire 1][seipWire 1][pad 2]
 */
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
const PLIC_HOST_SIZE = PLIC_HOST_MEIP_WIRE_OFFSET + 4;

type PlicContext = 'machine' | 'supervisor';

type PlicLocation =
  | { kind: 'priority'; source: number; byteOffset: number }
  | { kind: 'pending'; byteOffset: number }
  | { kind: 'enable'; context: PlicContext; byteOffset: number }
  | { kind: 'threshold'; context: PlicContext; byteOffset: number }
  | { kind: 'claim'; context: PlicContext; byteOffset: number };

const isValidSource = (source: number): boolean => source >= 1 && source <= PLIC_MAX_SOURCE;

const enableHostOffset = (context: PlicContext): number =>
  context === 'machine' ? PLIC_HOST_ENABLE_M : PLIC_HOST_ENABLE_S;

const thresholdHostOffset = (context: PlicContext): number =>
  context === 'machine' ? PLIC_HOST_THRESHOLD_M : PLIC_HOST_THRESHOLD_S;

const contextWireOffset = (context: PlicContext): number =>
  context === 'machine' ? PLIC_HOST_MEIP_WIRE_OFFSET : PLIC_HOST_SEIP_WIRE_OFFSET;

const plicHostIndex = (memory: Memory, offset: number): number => memory.plicHostBaseIndex + offset;

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

/** Aligned host index of a 32-bit shadow for priority / enable / threshold. */
const plicWordHostIndex = (
  memory: Memory,
  location: Exclude<PlicLocation, { kind: 'claim' | 'pending' }>
): number | null => {
  if (location.byteOffset !== 0) {
    return null;
  }
  switch (location.kind) {
    case 'priority':
      return plicHostIndex(memory, location.source * 4);
    case 'enable':
      return plicHostIndex(memory, enableHostOffset(location.context));
    case 'threshold':
      return plicHostIndex(memory, thresholdHostOffset(location.context));
  }
};

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

const plicAddressToLocation = (
  memory: Memory,
  address: ReadonlyUint8Array
): PlicLocation | null => {
  const offset = bytesToBigInt(address) - bytesToBigInt(memory.plicBaseAddress);
  if (offset < 0n || offset >= PLIC_WINDOW_SIZE) {
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

/** Drive a level-sensitive PLIC→hart wire and publish into the hart-wake level word. */
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

/**
 * Load an aligned 32-bit PLIC register (priority / enable / threshold / pending / claim).
 * Returns false when `address` is not an aligned mapped word.
 */
const loadPlicUint32 = (
  memory: Memory,
  address: ReadonlyUint8Array,
  destination: Uint8Array
): boolean => {
  const location = plicAddressToLocation(memory, address);
  if (location === null || location.byteOffset !== 0) {
    return false;
  }
  if (location.kind === 'claim') {
    unsignedNumberToBytes(destination, claimPlicSource(memory, location.context));
    return true;
  }
  if (location.kind === 'priority' && location.source === 0) {
    unsignedNumberToBytes(destination, 0);
    return true;
  }
  if (location.kind === 'pending') {
    unsignedNumberToBytes(
      destination,
      atomicLoad32({ bytes: memory.bytes, index: plicHostIndex(memory, PLIC_HOST_PENDING) })
    );
    return true;
  }
  const wordIndex = plicWordHostIndex(memory, location);
  if (wordIndex === null) {
    return false;
  }
  unsignedNumberToBytes(destination, atomicLoad32({ bytes: memory.bytes, index: wordIndex }));
  return true;
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

/**
 * Store an aligned 32-bit PLIC register in one atomic word write (no torn mid-store reads).
 * Returns false when `address` is not an aligned mapped word.
 */
const storePlicUint32 = (
  memory: Memory,
  address: ReadonlyUint8Array,
  source: ReadonlyUint8Array
): boolean => {
  const location = plicAddressToLocation(memory, address);
  if (location === null || location.byteOffset !== 0) {
    return false;
  }
  const value = bytesToNumber(source);
  switch (location.kind) {
    case 'pending':
      return true;
    case 'claim':
      completePlicSource(memory, value & 0xff);
      return true;
    case 'priority':
      if (location.source === 0) {
        return true;
      }
      atomicStore32({
        bytes: memory.bytes,
        index: plicHostIndex(memory, location.source * 4),
        value,
      });
      refreshAllContextWires(memory);
      return true;
    case 'enable':
      atomicStore32({
        bytes: memory.bytes,
        index: plicHostIndex(memory, enableHostOffset(location.context)),
        value: value & ~1,
      });
      refreshContextWire(memory, location.context);
      return true;
    case 'threshold':
      atomicStore32({
        bytes: memory.bytes,
        index: plicHostIndex(memory, thresholdHostOffset(location.context)),
        value,
      });
      refreshContextWire(memory, location.context);
      return true;
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
  memory.bytes.fill(
    0,
    memory.plicHostBaseIndex,
    memory.plicHostBaseIndex + PLIC_HOST_MEIP_WIRE_OFFSET
  );
  setPlicContextWire(memory, 'machine', false);
  setPlicContextWire(memory, 'supervisor', false);
};

export {
  PLIC_HOST_SIZE,
  PLIC_SOURCE_UART,
  PLIC_WINDOW_SIZE,
  initializePlic,
  isPlicMachineExternalPending,
  isPlicSupervisorExternalPending,
  loadPlicByte,
  loadPlicUint32,
  plicAddressToLocation,
  setPlicSourcePending,
  storePlicByte,
  storePlicUint32,
};
