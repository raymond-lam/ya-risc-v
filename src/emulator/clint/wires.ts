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
 * CLINT IRQ wires — level-sensitive machine timer / machine software / supervisor timer pending
 * bits in the host slab.
 */

import {
  CLINT_HOST_MACHINE_TIMER_WIRE_OFFSET,
  CLINT_HOST_MACHINE_SOFTWARE_WIRE_OFFSET,
  CLINT_HOST_SUPERVISOR_TIMER_WIRE_OFFSET,
  clintByteIndex,
} from '#emulator/clint/layout';
import { setIrqWire, IRQ_LEVEL_MSIP, IRQ_LEVEL_MTIP, IRQ_LEVEL_STIP } from '#emulator/irq-level';
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

/** Drive the level-sensitive CLINT machine timer IRQ wire (1 = pending). */
const setClintMachineTimerWire = (memory: Memory, pending: boolean): void => {
  setClintIrqWire(memory, CLINT_HOST_MACHINE_TIMER_WIRE_OFFSET, pending, IRQ_LEVEL_MTIP);
};

/** Level of the CLINT machine timer wire (sampled by the hart into `mip.MTIP`). */
const isClintMachineTimerPending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, clintByteIndex(memory, CLINT_HOST_MACHINE_TIMER_WIRE_OFFSET)) !== 0;

/** Drive the level-sensitive CLINT supervisor timer IRQ wire (1 = pending). */
const setClintSupervisorTimerWire = (memory: Memory, pending: boolean): void => {
  setClintIrqWire(memory, CLINT_HOST_SUPERVISOR_TIMER_WIRE_OFFSET, pending, IRQ_LEVEL_STIP);
};

/** Level of the CLINT supervisor timer wire (sampled by the hart into `mip.STIP`). */
const isClintSupervisorTimerPending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, clintByteIndex(memory, CLINT_HOST_SUPERVISOR_TIMER_WIRE_OFFSET)) !== 0;

/** Drive the level-sensitive CLINT machine software IRQ wire (1 = pending). */
const setClintMachineSoftwareWire = (memory: Memory, pending: boolean): void => {
  setClintIrqWire(memory, CLINT_HOST_MACHINE_SOFTWARE_WIRE_OFFSET, pending, IRQ_LEVEL_MSIP);
};

/** Level of the CLINT machine software wire (sampled by the hart into `mip.MSIP`). */
const isClintMachineSoftwarePending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, clintByteIndex(memory, CLINT_HOST_MACHINE_SOFTWARE_WIRE_OFFSET)) !== 0;

export {
  isClintMachineSoftwarePending,
  isClintMachineTimerPending,
  isClintSupervisorTimerPending,
  setClintMachineTimerWire,
  setClintMachineSoftwareWire,
  setClintSupervisorTimerWire,
};
