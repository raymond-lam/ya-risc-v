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
import { prepareStoreAccess, type PreparedAccess } from '#emulator/cpu/paging';
import { satpTranslationIsActive } from '#emulator/cpu/registers';
import { physicalMemoryAccessDenied } from '#emulator/cpu/pmp';
import { CAUSE_STORE_AMO_ACCESS_FAULT } from '#emulator/cpu/trap';
import { enterTrap } from '#emulator/cpu/trap';
import { readGeneralPurposeRegister, advanceProgramCounter } from '#emulator/cpu/registers';
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
 * Check PMP and mapped in bare mode.
 * In Sv39 mode, prepareStoreAccess already does these checks.
 */
const checkBareModeAccess = (
  registers: Registers,
  memory: Memory,
  physicalAddress: ReadonlyUint8Array,
  byteLength: number,
  address: ReadonlyUint8Array
): boolean => {
  if (
    physicalMemoryAccessDenied({ registers, address: physicalAddress, byteLength, access: 'store' })
  ) {
    enterTrap(registers, CAUSE_STORE_AMO_ACCESS_FAULT, address);
    return false;
  }
  if (!guestAccessIsMapped({ memory, address: physicalAddress, byteLength })) {
    enterTrap(registers, CAUSE_STORE_AMO_ACCESS_FAULT, address);
    return false;
  }
  return true;
};

/** sb: mem[rs1+imm] = rs2[7:0]. */
const sb = async (
  registers: Registers,
  memory: Memory,
  args: StoreArgs,
  instructionByteLength: ReadonlyUint8Array
): Promise<void> => {
  const address = storeEffectiveAddress(registers, args);
  const prepared: PreparedAccess = await prepareStoreAccess({
    registers,
    memory,
    address,
    byteLength: 1,
  });
  if (prepared.denied) {
    return;
  }
  if (!satpTranslationIsActive(registers)) {
    if (!checkBareModeAccess(registers, memory, prepared.physicalAddress, 1, address)) {
      return;
    }
  }
  await storeBytes({
    memory,
    address: prepared.physicalAddress,
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 1,
  });
  advanceProgramCounter(registers, instructionByteLength);
};

/** sh: mem[rs1+imm] = rs2[15:0]. */
const sh = async (
  registers: Registers,
  memory: Memory,
  args: StoreArgs,
  instructionByteLength: ReadonlyUint8Array
): Promise<void> => {
  const address = storeEffectiveAddress(registers, args);
  const prepared: PreparedAccess = await prepareStoreAccess({
    registers,
    memory,
    address,
    byteLength: 2,
  });
  if (prepared.denied) {
    return;
  }
  if (!satpTranslationIsActive(registers)) {
    if (!checkBareModeAccess(registers, memory, prepared.physicalAddress, 2, address)) {
      return;
    }
  }
  await storeBytes({
    memory,
    address: prepared.physicalAddress,
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 2,
  });
  advanceProgramCounter(registers, instructionByteLength);
};

/** sw: mem[rs1+imm] = rs2[31:0]. */
const sw = async (
  registers: Registers,
  memory: Memory,
  args: StoreArgs,
  instructionByteLength: ReadonlyUint8Array
): Promise<void> => {
  const address = storeEffectiveAddress(registers, args);
  const prepared: PreparedAccess = await prepareStoreAccess({
    registers,
    memory,
    address,
    byteLength: 4,
  });
  if (prepared.denied) {
    return;
  }
  if (!satpTranslationIsActive(registers)) {
    if (!checkBareModeAccess(registers, memory, prepared.physicalAddress, 4, address)) {
      return;
    }
  }
  await storeBytes({
    memory,
    address: prepared.physicalAddress,
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 4,
  });
  advanceProgramCounter(registers, instructionByteLength);
};

/** sd: mem[rs1+imm] = rs2. */
const sd = async (
  registers: Registers,
  memory: Memory,
  args: StoreArgs,
  instructionByteLength: ReadonlyUint8Array
): Promise<void> => {
  const address = storeEffectiveAddress(registers, args);
  const prepared: PreparedAccess = await prepareStoreAccess({
    registers,
    memory,
    address,
    byteLength: 8,
  });
  if (prepared.denied) {
    return;
  }
  if (!satpTranslationIsActive(registers)) {
    if (!checkBareModeAccess(registers, memory, prepared.physicalAddress, 8, address)) {
      return;
    }
  }
  await storeBytes({
    memory,
    address: prepared.physicalAddress,
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 8,
  });
  advanceProgramCounter(registers, instructionByteLength);
};

export { sb, sh, sw, sd };
