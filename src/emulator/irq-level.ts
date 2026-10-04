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
 * IRQ-level region — host-only Int32 OR of device IRQ levels for `wfi`.
 * No guestAddress; devices publish via `setIrqWire`.
 */

import { bytesToInt32Array } from '#utils/bytes';
import { WAKE_HOST_SIZE, waitWake } from '#emulator/wake';
import { bigIntAsNumber } from '#utils/int';
import type { Memory } from '#emulator/memory';

/** Packed-region id for the IRQ-level word (`createMemory` / `regions.get`). */
const IRQ_LEVEL_REGION_ID = 'irqLevel';

/** Host slab size (one Int32 wake / level word). */
const IRQ_LEVEL_HOST_BYTE_LENGTH = BigInt(WAKE_HOST_SIZE);

/** IRQ level bits (match `mip` interrupt numbers for clarity). */
const IRQ_LEVEL_MSIP = 1 << 3;
const IRQ_LEVEL_MTIP = 1 << 7;
const IRQ_LEVEL_SEIP = 1 << 9;
const IRQ_LEVEL_MEIP = 1 << 11;

const irqLevelRegion = (memory: Memory) => {
  const region = memory.regions.get(IRQ_LEVEL_REGION_ID);
  if (region === undefined) {
    throw new Error(`Memory region '${IRQ_LEVEL_REGION_ID}' is not packed.`);
  }
  if (region.guestAddress !== null) {
    throw new Error(`Memory region '${IRQ_LEVEL_REGION_ID}' is guest-mapped; expected host-only.`);
  }
  return region;
};

const irqLevelWords = (memory: Memory): Int32Array =>
  bytesToInt32Array(memory.bytes, bigIntAsNumber(irqLevelRegion(memory).hostIndex));

/** Current published OR of device IRQ level bits. */
const loadIrqLevel = (memory: Memory): number => Atomics.load(irqLevelWords(memory), 0);

/**
 * Drive a level-sensitive IRQ wire byte at a TypedArray host byte index and
 * publish it into the irq-level Int32. Notifies when the published level word changes.
 */
const setIrqWire = (
  memory: Memory,
  hostByteIndex: number,
  pending: boolean,
  levelBit: number
): void => {
  Atomics.store(memory.bytes, hostByteIndex, pending ? 1 : 0);
  const wake = irqLevelWords(memory);
  let previous = Atomics.load(wake, 0);
  for (;;) {
    const next = pending ? previous | levelBit : previous & ~levelBit;
    const current = Atomics.compareExchange(wake, 0, previous, next);
    if (current === previous) {
      if (next !== previous) {
        Atomics.notify(wake, 0);
      }
      return;
    }
    previous = current;
  }
};

/**
 * Sleep until the IRQ-level word differs from `fromLevel`.
 * Callers double-check `mip ∧ mie` around loading `fromLevel` (see `wfi`).
 */
const waitIrqLevel = (memory: Memory, fromLevel: number): Promise<void> =>
  waitWake({
    bytes: memory.bytes,
    index: bigIntAsNumber(irqLevelRegion(memory).hostIndex),
    fromLevel,
  });

export {
  IRQ_LEVEL_HOST_BYTE_LENGTH,
  IRQ_LEVEL_MEIP,
  IRQ_LEVEL_MSIP,
  IRQ_LEVEL_MTIP,
  IRQ_LEVEL_REGION_ID,
  IRQ_LEVEL_SEIP,
  loadIrqLevel,
  setIrqWire,
  waitIrqLevel,
};
