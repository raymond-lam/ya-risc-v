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

import type { Memory } from '#emulator/memory/types';

/** Host Int32 wake word for `wfi` (`Atomics.wait` / `notify`). */
const HART_WAKE_HOST_SIZE = 4;

const hartWakeWords = (memory: Memory): Int32Array =>
  new Int32Array(memory.bytes.buffer, memory.hartWakeHostIndex, 1);

/** Read the shared wake word (for tests). */
const readHartWake = (memory: Memory): number => Atomics.load(hartWakeWords(memory), 0);

/**
 * Signal a hart waiting in `wfi` that an interrupt source may now be pending.
 * Devices call this on a 0→1 IRQ-wire transition (CLINT today; PLIC later).
 */
const notifyHartWake = (memory: Memory): void => {
  const wake = hartWakeWords(memory);
  Atomics.add(wake, 0, 1);
  Atomics.notify(wake, 0);
};

/**
 * Snapshot the wake word, then wait while it still equals that value (`Atomics.wait`).
 * Callers must sample IRQ state before calling.
 */
const waitHartWake = (memory: Memory): void => {
  const wake = hartWakeWords(memory);
  Atomics.wait(wake, 0, Atomics.load(wake, 0));
};

export { HART_WAKE_HOST_SIZE, readHartWake, notifyHartWake, waitHartWake };
