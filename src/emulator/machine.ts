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
 * Machine-level composition of device completions, hart interrupt sampling, and `wfi` wake.
 *
 * The CPU instruction package owns ISA behavior; this module owns the cross-device policy.
 * CPU worker entrypoints use this explicit machine-composition boundary rather than importing
 * a device package into instruction handlers or the device-wire sampler. Device workers
 * publish host-only completion levels, while the CPU worker remains the sole writer of guest
 * RAM. It services a completion before sampling PLIC wires, ensuring that the completed
 * status/used-ring/DMA writes are visible before the device's PLIC source is asserted and the
 * corresponding interrupt is sampled.
 */

import { isPendingEnabledInterrupt } from '#emulator/cpu/trap';
import sampleDevicePending from '#emulator/cpu/sample-device-pending';
import type { Registers } from '#emulator/cpu/types';
import { loadIrqLevel, waitIrqLevel } from '#emulator/irq-level';
import type { Memory } from '#emulator/memory';
import {
  loadVirtioDiskCompletionSeq,
  serviceVirtioDiskQueue,
  waitVirtioDiskCompletion,
} from '#emulator/virtio';

/** Service worker completions before sampling the hart's device interrupt inputs. */
const sampleMachineInterrupts = (registers: Registers, memory: Memory): void => {
  serviceVirtioDiskQueue(memory);
  sampleDevicePending(registers, memory);
};

/**
 * Wait for an enabled interrupt, servicing device completions before each PLIC sample.
 * Snapshot and recheck both the IRQ level and worker completion word before sleeping; a
 * completion before the snapshot is serviced by the second pass, and one after it notifies
 * the completion waiter. Losing waiters are aborted after the race to release their
 * `waitAsync` keepalive handles.
 */
const waitForMachineInterrupt = async (registers: Registers, memory: Memory): Promise<void> => {
  for (;;) {
    sampleMachineInterrupts(registers, memory);
    if (isPendingEnabledInterrupt(registers)) {
      return;
    }
    const irqLevel = loadIrqLevel(memory);
    const completionLevel = loadVirtioDiskCompletionSeq(memory);
    sampleMachineInterrupts(registers, memory);
    if (isPendingEnabledInterrupt(registers)) {
      return;
    }
    const wakeRace = new AbortController();
    await Promise.race([
      waitIrqLevel(memory, irqLevel, wakeRace.signal),
      waitVirtioDiskCompletion(memory, completionLevel, wakeRace.signal),
    ]).finally(() => {
      wakeRace.abort();
    });
  }
};

export { sampleMachineInterrupts, waitForMachineInterrupt };
