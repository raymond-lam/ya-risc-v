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
import { copyBytes } from '#utils/bytes';
import applyBootHandoff from '#emulator/cpu/boot';
import decode, { ENCODING_LENGTH_32_BIT, ENCODING_LENGTH_MASK } from '#emulator/cpu/decode';
import { physicalMemoryAccessDenied } from '#emulator/cpu/pmp';
import {
  beginInstructionRetire,
  commitInstructionRetire,
  createRegisters,
  readProgramCounter,
  setProgramCounter,
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
  const pc = readProgramCounter(registers);
  // Load all four bytes speculatively before any checks. This is safe because loadBytes is
  // a raw host-side read that cannot fault or mutate state: unmapped/past-end bytes arrive
  // as 0, and a PMP-denied byte read into this scratch buffer is unobservable — the
  // width-checked trap below discards the buffer before decode consumes it.
  loadBytes({
    destination: instructionBytes,
    memory,
    address: pc,
    byteLength: 4,
  });
  // Derive the instruction length from byte 0 before any width checks. A 16-bit instruction
  // at the end of the RAM window must not fault on bytes it does not fetch, so the
  // mapping/permission check uses this length (2) and the speculative trailing zeros never
  // matter. A 32-bit instruction is one architectural access: the lowest matching PMP
  // entry must cover the whole 4 bytes, and an instruction straddling the end of the
  // window/mapping faults — even when its first 2 bytes are mapped and its last 2 are not.
  const length = (instructionBytes[0]! & ENCODING_LENGTH_MASK) === ENCODING_LENGTH_32_BIT ? 4 : 2;
  if (physicalMemoryAccessDenied({ registers, address: pc, byteLength: length, access: 'fetch' })) {
    enterTrap(registers, CAUSE_INSTRUCTION_ACCESS_FAULT, copyBytes(new Uint8Array(8), pc));
    return false;
  }
  if (trapIfFetchUnmapped(registers, memory, pc, length)) {
    return false;
  }
  return true;
};

const main = async (): Promise<void> => {
  const { memory, resetPc, deviceTreeAddress } = workerData as CpuWorkerData;
  const registers = createRegisters();
  setProgramCounter(registers, resetPc);
  applyBootHandoff(registers, deviceTreeAddress);
  const instructionBytes = new Uint8Array(4);

  // The hart runs until the host tears the worker down. A syscon poweroff/reboot
  // request is modeled as a yank: the host watch sees the request and stops the
  // worker, cutting power at a deliberately nondeterministic point — like real
  // silicon, where the window between the power register write and the loss of
  // power is physical. There is no in-worker halt check on purpose; correct guests
  // are yank-safe (after the finisher store they spin or `wfi` and do nothing
  // observable).
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
