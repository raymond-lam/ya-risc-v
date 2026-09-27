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

import { bytesToInt32Array } from '#utils/bytes';
import { WAKE_HOST_SIZE, waitWake } from '#emulator/memory/atomics';
import type { Memory } from '#emulator/memory/types';

/** Host Int32: OR of device IRQ levels for `wfi` (`Atomics.waitAsync` / `notify`). */
const HART_WAKE_HOST_SIZE = WAKE_HOST_SIZE;

/** Hart-wake level bits (match `mip` interrupt numbers for clarity). */
const IRQ_LEVEL_MSIP = 1 << 3;
const IRQ_LEVEL_MTIP = 1 << 7;
const IRQ_LEVEL_SEIP = 1 << 9;
const IRQ_LEVEL_MEIP = 1 << 11;

const hartIrqLevelWords = (memory: Memory): Int32Array =>
  bytesToInt32Array(memory.bytes, memory.hartWakeHostIndex);

/** Current published OR of device IRQ level bits (host wake word). */
const loadHartIrqLevel = (memory: Memory): number => Atomics.load(hartIrqLevelWords(memory), 0);

/**
 * Drive a level-sensitive IRQ wire byte and publish it into the hart-wake Int32.
 * Notifies when the published level word changes.
 */
const setIrqWire = (
  memory: Memory,
  hostByteIndex: number,
  pending: boolean,
  levelBit: number
): void => {
  Atomics.store(memory.bytes, hostByteIndex, pending ? 1 : 0);
  const wake = hartIrqLevelWords(memory);
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
 * Sleep until the hart IRQ-level word differs from `fromLevel`.
 * Callers double-check `mip ∧ mie` around loading `fromLevel` (see `wfi`).
 */
const waitHartWake = (memory: Memory, fromLevel: number): Promise<void> =>
  waitWake({ bytes: memory.bytes, index: memory.hartWakeHostIndex, fromLevel });

export {
  HART_WAKE_HOST_SIZE,
  IRQ_LEVEL_MEIP,
  IRQ_LEVEL_MSIP,
  IRQ_LEVEL_MTIP,
  IRQ_LEVEL_SEIP,
  loadHartIrqLevel,
  setIrqWire,
  waitHartWake,
};
