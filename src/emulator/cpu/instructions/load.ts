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

import { addBytes, signExtendBytes, zeroExtendBytes } from '#utils/bytes';
import { prepareLoadAccess, type PreparedAccess } from '#emulator/cpu/paging';
import { satpTranslationIsActive } from '#emulator/cpu/registers';
import { physicalMemoryAccessDenied } from '#emulator/cpu/pmp';
import {
  readGeneralPurposeRegister,
  writeGeneralPurposeRegister,
  advanceProgramCounter,
} from '#emulator/cpu/registers';
import { CAUSE_LOAD_ACCESS_FAULT } from '#emulator/cpu/trap';
import { enterTrap } from '#emulator/cpu/trap';
import type { Registers } from '#emulator/cpu/types';
import type { Memory } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';
import { guestAccessIsMapped, loadBytes } from '#emulator/memory';

type LoadArgs = {
  destinationRegister: number;
  sourceRegister1: number;
  immediate: ReadonlyUint8Array;
};

const loadEffectiveAddress = (registers: Registers, args: LoadArgs): ReadonlyUint8Array =>
  addBytes(
    new Uint8Array(8),
    readGeneralPurposeRegister(registers, args.sourceRegister1),
    args.immediate
  );

/**
 * Check PMP and mapped in bare mode.
 * In Sv39 mode, prepareLoadAccess already does these checks.
 */
const checkBareModeAccess = (
  registers: Registers,
  memory: Memory,
  physicalAddress: ReadonlyUint8Array,
  byteLength: number,
  address: ReadonlyUint8Array
): boolean => {
  if (
    physicalMemoryAccessDenied({ registers, address: physicalAddress, byteLength, access: 'load' })
  ) {
    enterTrap(registers, CAUSE_LOAD_ACCESS_FAULT, address);
    return false;
  }
  if (!guestAccessIsMapped({ memory, address: physicalAddress, byteLength })) {
    enterTrap(registers, CAUSE_LOAD_ACCESS_FAULT, address);
    return false;
  }
  return true;
};

/** lb: rd = sext(mem[rs1+imm], 8). */
const lb = async (
  registers: Registers,
  memory: Memory,
  args: LoadArgs,
  instructionByteLength: ReadonlyUint8Array
): Promise<void> => {
  const address = loadEffectiveAddress(registers, args);
  const prepared: PreparedAccess = await prepareLoadAccess({
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
  const loaded = new Uint8Array(8);
  await loadBytes({
    destination: loaded,
    memory,
    address: prepared.physicalAddress,
    byteLength: 1,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, signExtendBytes(loaded, 1));
  advanceProgramCounter(registers, instructionByteLength);
};

/** lh: rd = sext(mem[rs1+imm], 16). */
const lh = async (
  registers: Registers,
  memory: Memory,
  args: LoadArgs,
  instructionByteLength: ReadonlyUint8Array
): Promise<void> => {
  const address = loadEffectiveAddress(registers, args);
  const prepared: PreparedAccess = await prepareLoadAccess({
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
  const loaded = new Uint8Array(8);
  await loadBytes({
    destination: loaded,
    memory,
    address: prepared.physicalAddress,
    byteLength: 2,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, signExtendBytes(loaded, 2));
  advanceProgramCounter(registers, instructionByteLength);
};

/** lw: rd = sext(mem[rs1+imm], 32). */
const lw = async (
  registers: Registers,
  memory: Memory,
  args: LoadArgs,
  instructionByteLength: ReadonlyUint8Array
): Promise<void> => {
  const address = loadEffectiveAddress(registers, args);
  const prepared: PreparedAccess = await prepareLoadAccess({
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
  const loaded = new Uint8Array(8);
  await loadBytes({
    destination: loaded,
    memory,
    address: prepared.physicalAddress,
    byteLength: 4,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, signExtendBytes(loaded, 4));
  advanceProgramCounter(registers, instructionByteLength);
};

/** ld: rd = mem[rs1+imm] (64 bits). */
const ld = async (
  registers: Registers,
  memory: Memory,
  args: LoadArgs,
  instructionByteLength: ReadonlyUint8Array
): Promise<void> => {
  const address = loadEffectiveAddress(registers, args);
  const prepared: PreparedAccess = await prepareLoadAccess({
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
  const loaded = new Uint8Array(8);
  await loadBytes({
    destination: loaded,
    memory,
    address: prepared.physicalAddress,
    byteLength: 8,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, loaded);
  advanceProgramCounter(registers, instructionByteLength);
};

/** lbu: rd = zext(mem[rs1+imm], 8). */
const lbu = async (
  registers: Registers,
  memory: Memory,
  args: LoadArgs,
  instructionByteLength: ReadonlyUint8Array
): Promise<void> => {
  const address = loadEffectiveAddress(registers, args);
  const prepared: PreparedAccess = await prepareLoadAccess({
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
  const loaded = new Uint8Array(8);
  await loadBytes({
    destination: loaded,
    memory,
    address: prepared.physicalAddress,
    byteLength: 1,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, zeroExtendBytes(loaded, 1));
  advanceProgramCounter(registers, instructionByteLength);
};

/** lhu: rd = zext(mem[rs1+imm], 16). */
const lhu = async (
  registers: Registers,
  memory: Memory,
  args: LoadArgs,
  instructionByteLength: ReadonlyUint8Array
): Promise<void> => {
  const address = loadEffectiveAddress(registers, args);
  const prepared: PreparedAccess = await prepareLoadAccess({
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
  const loaded = new Uint8Array(8);
  await loadBytes({
    destination: loaded,
    memory,
    address: prepared.physicalAddress,
    byteLength: 2,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, zeroExtendBytes(loaded, 2));
  advanceProgramCounter(registers, instructionByteLength);
};

/** lwu: rd = zext(mem[rs1+imm], 32). */
const lwu = async (
  registers: Registers,
  memory: Memory,
  args: LoadArgs,
  instructionByteLength: ReadonlyUint8Array
): Promise<void> => {
  const address = loadEffectiveAddress(registers, args);
  const prepared: PreparedAccess = await prepareLoadAccess({
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
  const loaded = new Uint8Array(8);
  await loadBytes({
    destination: loaded,
    memory,
    address: prepared.physicalAddress,
    byteLength: 4,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, zeroExtendBytes(loaded, 4));
  advanceProgramCounter(registers, instructionByteLength);
};

export { lb, lh, lw, ld, lbu, lhu, lwu };
