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

import {
  isClintMachineSoftwarePending,
  isClintMachineTimerPending,
  isClintSupervisorTimerPending,
} from '#emulator/clint';
import {
  publishSupervisorTimerCompare,
  setMachineExternalInterruptPending,
  setMachineSoftwareInterruptPending,
  setMachineTimerInterruptPending,
  setSupervisorExternalInterruptPending,
  setSupervisorTimerInterruptPending,
} from '#emulator/cpu/registers';
import type { Registers } from '#emulator/cpu/types';
import type { Memory } from '#emulator/memory';
import { isPlicMachineExternalPending, isPlicSupervisorExternalPending } from '#emulator/plic';

/** Sample CLINT/PLIC wires into `mip` (device-driven pending bits). */
const sampleDevicePending = (registers: Registers, memory: Memory): void => {
  // CLINT: machine timer / machine software wires, then the Sstc mirror's supervisor timer wire.
  setMachineTimerInterruptPending(registers, isClintMachineTimerPending(memory));
  setMachineSoftwareInterruptPending(registers, isClintMachineSoftwarePending(memory));
  // `stimecmp` is hart-local CSR state and workers share only the SAB, so publish it into the
  // CLINT mirror before sampling its wire (as fresh as the 1 ms timebase tick).
  publishSupervisorTimerCompare(registers, memory);
  setSupervisorTimerInterruptPending(registers, isClintSupervisorTimerPending(memory));
  // PLIC: machine / supervisor external wires.
  setMachineExternalInterruptPending(registers, isPlicMachineExternalPending(memory));
  setSupervisorExternalInterruptPending(registers, isPlicSupervisorExternalPending(memory));
};

export default sampleDevicePending;
