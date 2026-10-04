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
 * PLIC IRQ wires — level-sensitive MEIP / SEIP pending bits in the host slab.
 */

import {
  PLIC_HOST_MEIP_WIRE_OFFSET,
  PLIC_HOST_SEIP_WIRE_OFFSET,
  contextWireOffset,
  plicHostIndex,
  type PlicContext,
} from '#emulator/plic/layout';
import { setIrqWire, IRQ_LEVEL_MEIP, IRQ_LEVEL_SEIP } from '#emulator/irq-level';
import type { Memory } from '#emulator/memory';

/** Drive a level-sensitive PLIC→hart wire and publish into the irq-level word. */
const setPlicContextWire = (memory: Memory, context: PlicContext, pending: boolean): void => {
  setIrqWire(
    memory,
    plicHostIndex(memory, contextWireOffset(context)),
    pending,
    context === 'machine' ? IRQ_LEVEL_MEIP : IRQ_LEVEL_SEIP
  );
};

/** Level of the PLIC machine-external wire (sampled into `mip.MEIP`). */
const isPlicMachineExternalPending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, plicHostIndex(memory, PLIC_HOST_MEIP_WIRE_OFFSET)) !== 0;

/** Level of the PLIC supervisor-external wire (sampled into `mip.SEIP`). */
const isPlicSupervisorExternalPending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, plicHostIndex(memory, PLIC_HOST_SEIP_WIRE_OFFSET)) !== 0;

export { isPlicMachineExternalPending, isPlicSupervisorExternalPending, setPlicContextWire };
