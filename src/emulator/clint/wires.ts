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
 * CLINT IRQ wires — level-sensitive timer / software pending bits in the host slab.
 */

import {
  CLINT_HOST_SOFTWARE_WIRE_OFFSET,
  CLINT_HOST_TIMER_WIRE_OFFSET,
  clintByteIndex,
} from '#emulator/clint/layout';
import { setIrqWire, IRQ_LEVEL_MSIP, IRQ_LEVEL_MTIP } from '#emulator/irq-level';
import type { Memory } from '#emulator/memory';

/** Drive a level-sensitive CLINT IRQ wire (1 = pending) and publish into the irq-level word. */
const setClintIrqWire = (
  memory: Memory,
  wireOffset: number,
  pending: boolean,
  levelBit: number
): void => {
  setIrqWire(memory, clintByteIndex(memory, wireOffset), pending, levelBit);
};

/** Drive the level-sensitive CLINT timer IRQ wire (1 = pending). */
const setClintTimerWire = (memory: Memory, pending: boolean): void => {
  setClintIrqWire(memory, CLINT_HOST_TIMER_WIRE_OFFSET, pending, IRQ_LEVEL_MTIP);
};

/** Level of the CLINT timer interrupt wire (sampled by the hart into `mip.MTIP`). */
const isClintMachineTimerPending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, clintByteIndex(memory, CLINT_HOST_TIMER_WIRE_OFFSET)) !== 0;

/** Drive the level-sensitive CLINT software IRQ wire (1 = pending). */
const setClintSoftwareWire = (memory: Memory, pending: boolean): void => {
  setClintIrqWire(memory, CLINT_HOST_SOFTWARE_WIRE_OFFSET, pending, IRQ_LEVEL_MSIP);
};

/** Level of the CLINT software interrupt wire (sampled by the hart into `mip.MSIP`). */
const isClintMachineSoftwarePending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, clintByteIndex(memory, CLINT_HOST_SOFTWARE_WIRE_OFFSET)) !== 0;

export {
  isClintMachineSoftwarePending,
  isClintMachineTimerPending,
  setClintSoftwareWire,
  setClintTimerWire,
};
