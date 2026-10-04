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

import { parentPort, workerData } from 'node:worker_threads';
import decode from '#emulator/cpu/decode';
import {
  beginInstructionRetire,
  commitInstructionRetire,
  createRegisters,
  readProgramCounter,
  setProgramCounter,
} from '#emulator/cpu/registers';
import sampleDevicePending from '#emulator/cpu/sample-device-pending';
import { takeInterruptIfAny, trapIfInstructionAddressMisaligned } from '#emulator/cpu/trap';
import type { CpuWorkerData } from '#emulator/cpu/types';
import { loadBytes } from '#emulator/memory';

const isThenable = (value: unknown): value is PromiseLike<void> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PromiseLike<void>).then === 'function';

const main = async (): Promise<void> => {
  const { memory, resetPc } = workerData as CpuWorkerData;
  const registers = createRegisters();
  setProgramCounter(registers, resetPc);
  const instructionWord = new Uint8Array(4);

  // No exit condition: the hart runs until the host terminates us.
  for (;;) {
    // NOTE: IRQ wire sampling runs every instruction for interrupt latency correctness.
    // Coalescing samples across iterations would be a micro-opt with observable timing
    // changes; leave per-instruction sampling until a proven bottleneck exists.
    sampleDevicePending(registers, memory);
    if (takeInterruptIfAny(registers)) {
      continue;
    }
    if (trapIfInstructionAddressMisaligned(registers)) {
      continue;
    }
    loadBytes({
      destination: instructionWord,
      memory,
      address: readProgramCounter(registers),
      byteLength: 4,
    });
    beginInstructionRetire(registers);
    const [execute, instructionByteLength] = decode(instructionWord);
    // Only await async instructions (today: wfi). Sync thunks return void and must
    // not force a microtask per instruction on the hot path.
    const result = execute(registers, memory, instructionByteLength);
    if (isThenable(result)) {
      await result;
    }
    commitInstructionRetire(registers);
  }
};

if (parentPort !== null) {
  void main();
}
