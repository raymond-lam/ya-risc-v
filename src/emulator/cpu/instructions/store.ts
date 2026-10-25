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

import { addBytes } from '#utils/bytes';
import { physicalMemoryAccessDenied } from '#emulator/cpu/pmp';
import { readGeneralPurposeRegister, advanceProgramCounter } from '#emulator/cpu/registers';
import { CAUSE_STORE_AMO_ACCESS_FAULT, enterTrap } from '#emulator/cpu/trap';
import type { Registers } from '#emulator/cpu/types';
import type { Memory } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';
import { guestAccessIsMapped, storeBytes } from '#emulator/memory';

type StoreArgs = {
  sourceRegister1: number;
  sourceRegister2: number;
  immediate: ReadonlyUint8Array;
};

const storeEffectiveAddress = (registers: Registers, args: StoreArgs): ReadonlyUint8Array =>
  addBytes(
    new Uint8Array(8),
    readGeneralPurposeRegister(registers, args.sourceRegister1),
    args.immediate
  );

/**
 * Store/AMO access fault (cause 7) when the address is unmapped or PMP denies
 * the store. Does not write memory or advance the PC.
 */
const denyStore = (
  registers: Registers,
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: number
): boolean => {
  if (!guestAccessIsMapped({ memory, address, byteLength })) {
    enterTrap(registers, CAUSE_STORE_AMO_ACCESS_FAULT, address);
    return true;
  }
  if (!physicalMemoryAccessDenied({ registers, address, byteLength, access: 'store' })) {
    return false;
  }
  enterTrap(registers, CAUSE_STORE_AMO_ACCESS_FAULT, address);
  return true;
};

/** sb: mem[rs1+imm] = rs2[7:0]. */
const sb = (
  registers: Registers,
  memory: Memory,
  args: StoreArgs,
  instructionByteLength: ReadonlyUint8Array
): void => {
  const address = storeEffectiveAddress(registers, args);
  if (denyStore(registers, memory, address, 1)) {
    return;
  }
  storeBytes({
    memory,
    address,
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 1,
  });
  advanceProgramCounter(registers, instructionByteLength);
};

/** sh: mem[rs1+imm] = rs2[15:0]. */
const sh = (
  registers: Registers,
  memory: Memory,
  args: StoreArgs,
  instructionByteLength: ReadonlyUint8Array
): void => {
  const address = storeEffectiveAddress(registers, args);
  if (denyStore(registers, memory, address, 2)) {
    return;
  }
  storeBytes({
    memory,
    address,
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 2,
  });
  advanceProgramCounter(registers, instructionByteLength);
};

/** sw: mem[rs1+imm] = rs2[31:0]. */
const sw = (
  registers: Registers,
  memory: Memory,
  args: StoreArgs,
  instructionByteLength: ReadonlyUint8Array
): void => {
  const address = storeEffectiveAddress(registers, args);
  if (denyStore(registers, memory, address, 4)) {
    return;
  }
  storeBytes({
    memory,
    address,
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 4,
  });
  advanceProgramCounter(registers, instructionByteLength);
};

/** sd: mem[rs1+imm] = rs2. */
const sd = (
  registers: Registers,
  memory: Memory,
  args: StoreArgs,
  instructionByteLength: ReadonlyUint8Array
): void => {
  const address = storeEffectiveAddress(registers, args);
  if (denyStore(registers, memory, address, 8)) {
    return;
  }
  storeBytes({
    memory,
    address,
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 8,
  });
  advanceProgramCounter(registers, instructionByteLength);
};

export { sb, sh, sw, sd };
