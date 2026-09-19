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

import type { Memory } from '#emulator/memory';

/**
 * Wire bytes within the CLINT host region (must match packing in `memory/clint.ts`:
 *   [mtime 8][mtimecmp 8][timerWire 1][softwareWire 1][pad 6][epochNs 8]).
 */
const CLINT_HOST_TIMER_WIRE_OFFSET = 16;
const CLINT_HOST_SOFTWARE_WIRE_OFFSET = 17;

/** Drive the level-sensitive CLINT timer IRQ wire (1 = pending). */
const setClintTimerWire = (memory: Memory, pending: boolean): void => {
  memory.bytes[memory.clintHostBaseIndex + CLINT_HOST_TIMER_WIRE_OFFSET] = pending ? 1 : 0;
};

/** Level of the CLINT timer interrupt wire (sampled by the hart into `mip.MTIP`). */
const isClintMachineTimerPending = (memory: Memory): boolean =>
  (memory.bytes[memory.clintHostBaseIndex + CLINT_HOST_TIMER_WIRE_OFFSET] ?? 0) !== 0;

/** Drive the level-sensitive CLINT software IRQ wire (1 = pending). */
const setClintSoftwareWire = (memory: Memory, pending: boolean): void => {
  memory.bytes[memory.clintHostBaseIndex + CLINT_HOST_SOFTWARE_WIRE_OFFSET] = pending ? 1 : 0;
};

/** Level of the CLINT software interrupt wire (sampled by the hart into `mip.MSIP`). */
const isClintMachineSoftwarePending = (memory: Memory): boolean =>
  (memory.bytes[memory.clintHostBaseIndex + CLINT_HOST_SOFTWARE_WIRE_OFFSET] ?? 0) !== 0;

export {
  isClintMachineSoftwarePending,
  isClintMachineTimerPending,
  setClintSoftwareWire,
  setClintTimerWire,
};
