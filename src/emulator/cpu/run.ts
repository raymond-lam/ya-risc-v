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
import { addBytes, copyBytes } from '#utils/bytes';
import applyBootHandoff from '#emulator/cpu/boot';
import decode, { ENCODING_LENGTH_32_BIT, ENCODING_LENGTH_MASK } from '#emulator/cpu/decode';
import { physicalMemoryAccessDenied } from '#emulator/cpu/pmp';
import {
  beginInstructionRetire,
  commitInstructionRetire,
  createRegisters,
  readProgramCounter,
  setProgramCounter,
  TWO_BYTES,
} from '#emulator/cpu/registers';
import sampleDevicePending from '#emulator/cpu/sample-device-pending';
import {
  CAUSE_INSTRUCTION_ACCESS_FAULT,
  enterTrap,
  takeInterruptIfAny,
  trapIfInstructionAddressMisaligned,
} from '#emulator/cpu/trap';
import type { CpuWorkerData, Registers } from '#emulator/cpu/types';
import type { ReadonlyUint8Array } from '#types';
import { guestAccessIsMapped, loadBytes, type Memory } from '#emulator/memory';

const isThenable = (value: unknown): value is PromiseLike<void> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PromiseLike<void>).then === 'function';

/** Fault (instruction access fault at the fetch address) when the range is unmapped. */
const trapIfFetchUnmapped = (
  registers: Registers,
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: number
): boolean => {
  if (guestAccessIsMapped({ memory, address, byteLength })) {
    return false;
  }
  enterTrap(registers, CAUSE_INSTRUCTION_ACCESS_FAULT, copyBytes(new Uint8Array(8), address));
  return true;
};

/** Fetch the instruction at the PC. */
const fetchInstruction = (
  registers: Registers,
  memory: Memory,
  instructionBytes: Uint8Array
): boolean => {
  instructionBytes.fill(0);
  const pc = readProgramCounter(registers);
  // The length is in the low two bits, so the first check can only cover those two bytes.
  // A 16-bit instruction stops after this and must not fault on bytes it does not fetch.
  if (physicalMemoryAccessDenied({ registers, address: pc, byteLength: 2, access: 'fetch' })) {
    enterTrap(registers, CAUSE_INSTRUCTION_ACCESS_FAULT, copyBytes(new Uint8Array(8), pc));
    return false;
  }
  if (trapIfFetchUnmapped(registers, memory, pc, 2)) {
    return false;
  }
  loadBytes({
    destination: instructionBytes.subarray(0, 2),
    memory,
    address: pc,
    byteLength: 2,
  });
  if ((instructionBytes[0]! & ENCODING_LENGTH_MASK) !== ENCODING_LENGTH_32_BIT) {
    return true;
  }
  // The encoding is 32 bits, so re-check all four bytes as one access. The lowest matching
  // entry has to cover the whole instruction; checking the upper parcel on its own would
  // allow an instruction that straddles an execute boundary.
  if (physicalMemoryAccessDenied({ registers, address: pc, byteLength: 4, access: 'fetch' })) {
    enterTrap(registers, CAUSE_INSTRUCTION_ACCESS_FAULT, copyBytes(new Uint8Array(8), pc));
    return false;
  }
  if (trapIfFetchUnmapped(registers, memory, pc, 4)) {
    return false;
  }
  loadBytes({
    destination: instructionBytes.subarray(2, 4),
    memory,
    address: addBytes(new Uint8Array(8), pc, TWO_BYTES),
    byteLength: 2,
  });
  return true;
};

const main = async (): Promise<void> => {
  const { memory, resetPc, deviceTreeAddress } = workerData as CpuWorkerData;
  const registers = createRegisters();
  setProgramCounter(registers, resetPc);
  applyBootHandoff(registers, deviceTreeAddress);
  const instructionBytes = new Uint8Array(4);

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
    if (!fetchInstruction(registers, memory, instructionBytes)) {
      continue;
    }
    beginInstructionRetire(registers);
    const [execute, instructionByteLength] = decode(instructionBytes);
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
