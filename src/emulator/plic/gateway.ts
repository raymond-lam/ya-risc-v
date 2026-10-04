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
 * PLIC claim gateway — pending/claimed bitfields, lock, claim/complete, wire refresh.
 *
 * Gateway mutations (`setPlicSourcePending` / claim / complete) and wire refresh run under
 * `gatewayLock` so UART pending refresh cannot race hart claim/complete.
 */

import {
  PLIC_HOST_CLAIMED_BY_M,
  PLIC_HOST_CLAIMED_BY_S,
  PLIC_HOST_GATEWAY_LOCK,
  PLIC_HOST_INPUT_LEVEL,
  PLIC_HOST_PENDING,
  PLIC_MAX_SOURCE,
  claimedByHostOffset,
  enableHostOffset,
  isValidSource,
  plicHostIndex,
  thresholdHostOffset,
  type PlicContext,
} from '#emulator/plic/layout';
import { setPlicContextWire } from '#emulator/plic/wires';
import type { Memory } from '#emulator/memory';
import { atomicLoad32, atomicLoadBit, atomicUpdateBit } from '#utils/atomics';
import { bytesToInt32Array } from '#utils/bytes';

/** Per-worker reentry depth for the PLIC gateway lock. */
let plicGatewayLockDepth = 0;

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

const isSourceClaimed = (memory: Memory, source: number): boolean =>
  isSourceBitSet(memory, PLIC_HOST_CLAIMED_BY_M, source) ||
  isSourceBitSet(memory, PLIC_HOST_CLAIMED_BY_S, source);

const plicGatewayLockInt32 = (memory: Memory): Int32Array =>
  bytesToInt32Array(memory.bytes, plicHostIndex(memory, PLIC_HOST_GATEWAY_LOCK));

const acquirePlicGatewayLock = (memory: Memory): void => {
  if (plicGatewayLockDepth > 0) {
    plicGatewayLockDepth += 1;
    return;
  }
  const lock = plicGatewayLockInt32(memory);
  for (;;) {
    if (Atomics.compareExchange(lock, 0, 0, 1) === 0) {
      plicGatewayLockDepth = 1;
      return;
    }
    Atomics.wait(lock, 0, 1);
  }
};

const releasePlicGatewayLock = (memory: Memory): void => {
  if (plicGatewayLockDepth <= 0) {
    return;
  }
  plicGatewayLockDepth -= 1;
  if (plicGatewayLockDepth > 0) {
    return;
  }
  const lock = plicGatewayLockInt32(memory);
  Atomics.store(lock, 0, 0);
  Atomics.notify(lock, 0, 1);
};

const withPlicGatewayLock = <T>(memory: Memory, run: () => T): T => {
  acquirePlicGatewayLock(memory);
  try {
    return run();
  } finally {
    releasePlicGatewayLock(memory);
  }
};

/** Reset the gateway monitor word (host init). */
const resetPlicGatewayLock = (memory: Memory): void => {
  Atomics.store(plicGatewayLockInt32(memory), 0, 0);
};

/**
 * Highest-priority pending∧enabled source above `threshold`, or 0.
 * Tie-break: lowest source id wins. Reads host shadows (not guest MMIO).
 * Caller must hold the gateway lock.
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

/**
 * Device-driven input level for `source` (1..31). Updates guest-visible pending
 * through the claim gateway, then refreshes M/S context wires.
 */
const setPlicSourcePending = (memory: Memory, source: number, pending: boolean): void => {
  if (!isValidSource(source)) {
    return;
  }
  withPlicGatewayLock(memory, () => {
    updateSourceBit(memory, PLIC_HOST_INPUT_LEVEL, source, pending);
    if (!pending) {
      updateSourceBit(memory, PLIC_HOST_PENDING, source, false);
    } else if (!isSourceClaimed(memory, source)) {
      updateSourceBit(memory, PLIC_HOST_PENDING, source, true);
    }
    refreshAllContextWires(memory);
  });
};

/** Claim: return id and clear global pending; mark gateway claimed by `context`. */
const claimPlicSource = (memory: Memory, context: PlicContext): number =>
  withPlicGatewayLock(memory, () => {
    const source = selectClaimableSource(memory, context);
    if (source !== 0) {
      updateSourceBit(memory, PLIC_HOST_PENDING, source, false);
      updateSourceBit(memory, claimedByHostOffset(context), source, true);
    }
    refreshAllContextWires(memory);
    return source;
  });

/**
 * Complete: release gateway for a source claimed by `context` only (SiFive: wrong-context
 * complete is ignored). Re-pending when the device input level is still high.
 */
const completePlicSource = (memory: Memory, context: PlicContext, source: number): void => {
  if (!isValidSource(source)) {
    return;
  }
  withPlicGatewayLock(memory, () => {
    if (!isSourceBitSet(memory, claimedByHostOffset(context), source)) {
      return;
    }
    updateSourceBit(memory, claimedByHostOffset(context), source, false);
    if (isSourceBitSet(memory, PLIC_HOST_INPUT_LEVEL, source)) {
      updateSourceBit(memory, PLIC_HOST_PENDING, source, true);
    }
    refreshAllContextWires(memory);
  });
};

export {
  claimPlicSource,
  completePlicSource,
  refreshAllContextWires,
  refreshContextWire,
  resetPlicGatewayLock,
  setPlicSourcePending,
  withPlicGatewayLock,
};
