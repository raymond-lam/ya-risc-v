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
import decode from '#cpu/decode.js';
import { loadBytes } from '#memory.js';
import { createRegisters, readProgramCounter, setProgramCounter } from '#cpu/registers.js';
import type { CpuWorkerData } from '#cpu/types.js';

const main = (): void => {
  const { memory, resetPc } = workerData as CpuWorkerData;
  const registers = createRegisters();
  setProgramCounter(registers, resetPc);
  const instructionWord = new Uint8Array(4);

  // No exit condition: the hart runs until the host terminates us.
  for (;;) {
    loadBytes({
      destination: instructionWord,
      memory,
      address: readProgramCounter(registers),
      byteLength: 4,
    });
    decode(instructionWord)(registers, memory);
  }
};

if (parentPort !== null) {
  main();
}
