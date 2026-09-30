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
  addBytes,
  andBytes,
  bytesToNumber,
  compareSignedBytes,
  compareUnsignedBytes,
  copyBytes,
  low32Bytes,
  orBytes,
  signExtendBytes,
  signedNumberToBytes,
  xorBytes,
  zeroExtendBytes,
} from '#utils/bytes';
import {
  advanceProgramCounter,
  readGeneralPurposeRegister,
  snapshotControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#emulator/cpu/registers';
import { CAUSE_STORE_AMO_ADDRESS_MISALIGNED, enterTrap } from '#emulator/cpu/trap';
import type { Registers } from '#emulator/cpu/types';
import {
  atomicRamCompareExchange,
  atomicRamLoad,
  atomicRamStore,
  setReservation,
  tryTakeReservation,
  type Memory,
} from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';

type AmoArgs = {
  destinationRegister: number;
  sourceRegister1: number;
  sourceRegister2: number;
};

const ZERO_BYTES = new Uint8Array(8) as ReadonlyUint8Array;
const ONE_BYTES = signedNumberToBytes(new Uint8Array(8), 1, 32) as ReadonlyUint8Array;

/** `mhartid` CSR address — indexes the shared reservation-monitor slot. */
const MHARTID = 0xf14;

const hartIdOf = (registers: Registers): number =>
  bytesToNumber(snapshotControlAndStatusRegister(registers, MHARTID));

/** Trap Store/AMO address misaligned (cause 6); do not fall back to non-atomic R/W. */
const trapStoreAmoMisaligned = (registers: Registers, address: ReadonlyUint8Array): void => {
  enterTrap(registers, CAUSE_STORE_AMO_ADDRESS_MISALIGNED, copyBytes(new Uint8Array(8), address));
};

/** lr.w: rd = sext(mem[rs1]); reserve 32 bits. Misaligned / non-RAM → trap (no reservation). */
const lrW = (registers: Registers, memory: Memory, args: AmoArgs): void => {
  const address = readGeneralPurposeRegister(registers, args.sourceRegister1);
  const oldValue = new Uint8Array(8);
  if (!atomicRamLoad({ destination: oldValue, memory, address, byteLength: 4 })) {
    trapStoreAmoMisaligned(registers, address);
    return;
  }
  signExtendBytes(oldValue, 4);
  setReservation(memory, hartIdOf(registers), address, 4);
  writeGeneralPurposeRegister(registers, args.destinationRegister, oldValue);
  advanceProgramCounter(registers);
};

/** lr.d: rd = mem[rs1]; reserve 64 bits. Misaligned / non-RAM → trap (no reservation). */
const lrD = (registers: Registers, memory: Memory, args: AmoArgs): void => {
  const address = readGeneralPurposeRegister(registers, args.sourceRegister1);
  const oldValue = new Uint8Array(8);
  if (!atomicRamLoad({ destination: oldValue, memory, address, byteLength: 8 })) {
    trapStoreAmoMisaligned(registers, address);
    return;
  }
  setReservation(memory, hartIdOf(registers), address, 8);
  writeGeneralPurposeRegister(registers, args.destinationRegister, oldValue);
  advanceProgramCounter(registers);
};

/**
 * sc.w: if reservation matches, mem[rs1] = rs2[31:0], rd = 0; else rd ≠ 0.
 * Misaligned / non-RAM → trap before taking the reservation.
 */
const scW = (registers: Registers, memory: Memory, args: AmoArgs): void => {
  const address = readGeneralPurposeRegister(registers, args.sourceRegister1);
  const probe = new Uint8Array(8);
  if (!atomicRamLoad({ destination: probe, memory, address, byteLength: 4 })) {
    trapStoreAmoMisaligned(registers, address);
    return;
  }
  const success = tryTakeReservation(memory, hartIdOf(registers), address, 4);
  if (success) {
    atomicRamStore({
      memory,
      address,
      source: readGeneralPurposeRegister(registers, args.sourceRegister2),
      byteLength: 4,
    });
  }
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    success ? ZERO_BYTES : ONE_BYTES
  );
  advanceProgramCounter(registers);
};

/**
 * sc.d: if reservation matches, mem[rs1] = rs2, rd = 0; else rd ≠ 0.
 * Misaligned / non-RAM → trap before taking the reservation.
 */
const scD = (registers: Registers, memory: Memory, args: AmoArgs): void => {
  const address = readGeneralPurposeRegister(registers, args.sourceRegister1);
  const probe = new Uint8Array(8);
  if (!atomicRamLoad({ destination: probe, memory, address, byteLength: 8 })) {
    trapStoreAmoMisaligned(registers, address);
    return;
  }
  const success = tryTakeReservation(memory, hartIdOf(registers), address, 8);
  if (success) {
    atomicRamStore({
      memory,
      address,
      source: readGeneralPurposeRegister(registers, args.sourceRegister2),
      byteLength: 8,
    });
  }
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    success ? ZERO_BYTES : ONE_BYTES
  );
  advanceProgramCounter(registers);
};

type AmoCombine = (
  oldValue: ReadonlyUint8Array,
  source: ReadonlyUint8Array,
  byteLength: 4 | 8
) => Uint8Array;

const amoReadModifyWrite = (
  registers: Registers,
  memory: Memory,
  args: AmoArgs,
  byteLength: 4 | 8,
  combine: AmoCombine
): void => {
  const address = readGeneralPurposeRegister(registers, args.sourceRegister1);
  const source = readGeneralPurposeRegister(registers, args.sourceRegister2);
  const oldValue = new Uint8Array(8);
  const observed = new Uint8Array(8);
  if (!atomicRamLoad({ destination: oldValue, memory, address, byteLength })) {
    trapStoreAmoMisaligned(registers, address);
    return;
  }
  for (;;) {
    const next = combine(oldValue, source, byteLength);
    if (
      atomicRamCompareExchange({
        destination: observed,
        memory,
        address,
        byteLength,
        expected: oldValue,
        desired: next,
      })
    ) {
      break;
    }
    copyBytes(oldValue, observed);
  }
  if (byteLength === 4) {
    signExtendBytes(oldValue, 4);
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, oldValue);
  advanceProgramCounter(registers);
};

const asSignedOperands = (
  oldValue: ReadonlyUint8Array,
  source: ReadonlyUint8Array,
  byteLength: 4 | 8
): { left: ReadonlyUint8Array; right: ReadonlyUint8Array } => {
  if (byteLength === 4) {
    return {
      left: signExtendBytes(copyBytes(new Uint8Array(8), oldValue), 4),
      right: signExtendBytes(copyBytes(new Uint8Array(8), source), 4),
    };
  }
  return { left: oldValue, right: source };
};

const asUnsignedOperands = (
  oldValue: ReadonlyUint8Array,
  source: ReadonlyUint8Array,
  byteLength: 4 | 8
): { left: ReadonlyUint8Array; right: ReadonlyUint8Array } => {
  if (byteLength === 4) {
    return {
      left: zeroExtendBytes(copyBytes(new Uint8Array(8), oldValue), 4),
      right: zeroExtendBytes(copyBytes(new Uint8Array(8), source), 4),
    };
  }
  return { left: oldValue, right: source };
};

const narrowStoreValue = (value: Uint8Array, byteLength: 4 | 8): Uint8Array =>
  byteLength === 4 ? low32Bytes(new Uint8Array(8), value) : value;

/** amoswap.w / amoswap.d */
const amoswap = (registers: Registers, memory: Memory, args: AmoArgs, byteLength: 4 | 8): void => {
  amoReadModifyWrite(registers, memory, args, byteLength, (_old, source) =>
    copyBytes(new Uint8Array(8), source)
  );
};

/** amoadd.w / amoadd.d */
const amoadd = (registers: Registers, memory: Memory, args: AmoArgs, byteLength: 4 | 8): void => {
  amoReadModifyWrite(registers, memory, args, byteLength, (oldValue, source, width) => {
    const { left, right } = asSignedOperands(oldValue, source, width);
    return narrowStoreValue(addBytes(new Uint8Array(8), left, right), width);
  });
};

/** amoxor.w / amoxor.d */
const amoxor = (registers: Registers, memory: Memory, args: AmoArgs, byteLength: 4 | 8): void => {
  amoReadModifyWrite(registers, memory, args, byteLength, (oldValue, source, width) => {
    const { left, right } = asSignedOperands(oldValue, source, width);
    return narrowStoreValue(xorBytes(new Uint8Array(8), left, right), width);
  });
};

/** amoand.w / amoand.d */
const amoand = (registers: Registers, memory: Memory, args: AmoArgs, byteLength: 4 | 8): void => {
  amoReadModifyWrite(registers, memory, args, byteLength, (oldValue, source, width) => {
    const { left, right } = asSignedOperands(oldValue, source, width);
    return narrowStoreValue(andBytes(new Uint8Array(8), left, right), width);
  });
};

/** amoor.w / amoor.d */
const amoor = (registers: Registers, memory: Memory, args: AmoArgs, byteLength: 4 | 8): void => {
  amoReadModifyWrite(registers, memory, args, byteLength, (oldValue, source, width) => {
    const { left, right } = asSignedOperands(oldValue, source, width);
    return narrowStoreValue(orBytes(new Uint8Array(8), left, right), width);
  });
};

/** amomin.w / amomin.d (signed) */
const amomin = (registers: Registers, memory: Memory, args: AmoArgs, byteLength: 4 | 8): void => {
  amoReadModifyWrite(registers, memory, args, byteLength, (oldValue, source, width) => {
    const { left, right } = asSignedOperands(oldValue, source, width);
    const next = compareSignedBytes(left, right) <= 0 ? left : right;
    return narrowStoreValue(copyBytes(new Uint8Array(8), next), width);
  });
};

/** amomax.w / amomax.d (signed) */
const amomax = (registers: Registers, memory: Memory, args: AmoArgs, byteLength: 4 | 8): void => {
  amoReadModifyWrite(registers, memory, args, byteLength, (oldValue, source, width) => {
    const { left, right } = asSignedOperands(oldValue, source, width);
    const next = compareSignedBytes(left, right) >= 0 ? left : right;
    return narrowStoreValue(copyBytes(new Uint8Array(8), next), width);
  });
};

/** amominu.w / amominu.d (unsigned) */
const amominu = (registers: Registers, memory: Memory, args: AmoArgs, byteLength: 4 | 8): void => {
  amoReadModifyWrite(registers, memory, args, byteLength, (oldValue, source, width) => {
    const { left, right } = asUnsignedOperands(oldValue, source, width);
    const next = compareUnsignedBytes(left, right) <= 0 ? left : right;
    return narrowStoreValue(copyBytes(new Uint8Array(8), next), width);
  });
};

/** amomaxu.w / amomaxu.d (unsigned) */
const amomaxu = (registers: Registers, memory: Memory, args: AmoArgs, byteLength: 4 | 8): void => {
  amoReadModifyWrite(registers, memory, args, byteLength, (oldValue, source, width) => {
    const { left, right } = asUnsignedOperands(oldValue, source, width);
    const next = compareUnsignedBytes(left, right) >= 0 ? left : right;
    return narrowStoreValue(copyBytes(new Uint8Array(8), next), width);
  });
};

const amoswapW = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amoswap(registers, memory, args, 4);
const amoswapD = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amoswap(registers, memory, args, 8);
const amoaddW = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amoadd(registers, memory, args, 4);
const amoaddD = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amoadd(registers, memory, args, 8);
const amoxorW = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amoxor(registers, memory, args, 4);
const amoxorD = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amoxor(registers, memory, args, 8);
const amoandW = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amoand(registers, memory, args, 4);
const amoandD = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amoand(registers, memory, args, 8);
const amoorW = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amoor(registers, memory, args, 4);
const amoorD = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amoor(registers, memory, args, 8);
const amominW = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amomin(registers, memory, args, 4);
const amominD = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amomin(registers, memory, args, 8);
const amomaxW = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amomax(registers, memory, args, 4);
const amomaxD = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amomax(registers, memory, args, 8);
const amominuW = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amominu(registers, memory, args, 4);
const amominuD = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amominu(registers, memory, args, 8);
const amomaxuW = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amomaxu(registers, memory, args, 4);
const amomaxuD = (registers: Registers, memory: Memory, args: AmoArgs): void =>
  amomaxu(registers, memory, args, 8);

export {
  lrW,
  lrD,
  scW,
  scD,
  amoswapW,
  amoswapD,
  amoaddW,
  amoaddD,
  amoxorW,
  amoxorD,
  amoandW,
  amoandD,
  amoorW,
  amoorD,
  amominW,
  amominD,
  amomaxW,
  amomaxD,
  amominuW,
  amominuD,
  amomaxuW,
  amomaxuD,
};
export type { AmoArgs };
