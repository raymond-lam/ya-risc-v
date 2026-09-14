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

import { bytesToBigInt, signedBytesToBigInt, unsignedBigIntToBytes } from '#utils/bytes';
import {
  readGeneralPurposeRegister,
  writeGeneralPurposeRegister,
  advanceProgramCounter,
} from '#emulator/cpu/registers';
import type { OpArgs } from '#emulator/cpu/instructions/op';
import type { Registers } from '#emulator/cpu/types';
import type { Memory } from '#emulator/memory';

const MASK64 = 0xffff_ffff_ffff_ffffn;
const SIGNED_MIN = -0x8000_0000_0000_0000n;

/** mul: rd = (rs1 × rs2)[63:0]. */
const mul = (registers: Registers, _memory: Memory, args: OpArgs): void => {
  const product =
    bytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister1)) *
    bytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister2));
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    unsignedBigIntToBytes(new Uint8Array(8), product & MASK64)
  );
  advanceProgramCounter(registers);
};

/** mulh: rd = (rs1_s × rs2_s)[127:64]. */
const mulh = (registers: Registers, _memory: Memory, args: OpArgs): void => {
  const product =
    signedBytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister1)) *
    signedBytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister2));
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    unsignedBigIntToBytes(new Uint8Array(8), (product >> 64n) & MASK64)
  );
  advanceProgramCounter(registers);
};

/** mulhsu: rd = (rs1_s × rs2_u)[127:64]. */
const mulhsu = (registers: Registers, _memory: Memory, args: OpArgs): void => {
  const product =
    signedBytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister1)) *
    bytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister2));
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    unsignedBigIntToBytes(new Uint8Array(8), (product >> 64n) & MASK64)
  );
  advanceProgramCounter(registers);
};

/** mulhu: rd = (rs1_u × rs2_u)[127:64]. */
const mulhu = (registers: Registers, _memory: Memory, args: OpArgs): void => {
  const product =
    bytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister1)) *
    bytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister2));
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    unsignedBigIntToBytes(new Uint8Array(8), (product >> 64n) & MASK64)
  );
  advanceProgramCounter(registers);
};

/** div: rd = rs1_s ÷ rs2_s (toward zero); ÷0 → −1; overflow → dividend. */
const div = (registers: Registers, _memory: Memory, args: OpArgs): void => {
  const dividend = signedBytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister1));
  const divisor = signedBytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister2));
  let quotient: bigint;
  if (divisor === 0n) {
    quotient = -1n;
  } else if (dividend === SIGNED_MIN && divisor === -1n) {
    quotient = dividend;
  } else {
    quotient = dividend / divisor;
  }
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    unsignedBigIntToBytes(new Uint8Array(8), quotient & MASK64)
  );
  advanceProgramCounter(registers);
};

/** divu: rd = rs1_u ÷ rs2_u; ÷0 → all ones. */
const divu = (registers: Registers, _memory: Memory, args: OpArgs): void => {
  const dividend = bytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister1));
  const divisor = bytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister2));
  const quotient = divisor === 0n ? MASK64 : dividend / divisor;
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    unsignedBigIntToBytes(new Uint8Array(8), quotient & MASK64)
  );
  advanceProgramCounter(registers);
};

/** rem: rd = rs1_s % rs2_s; ÷0 → dividend; overflow → 0. */
const rem = (registers: Registers, _memory: Memory, args: OpArgs): void => {
  const dividend = signedBytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister1));
  const divisor = signedBytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister2));
  let remainder: bigint;
  if (divisor === 0n) {
    remainder = dividend;
  } else if (dividend === SIGNED_MIN && divisor === -1n) {
    remainder = 0n;
  } else {
    remainder = dividend % divisor;
  }
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    unsignedBigIntToBytes(new Uint8Array(8), remainder & MASK64)
  );
  advanceProgramCounter(registers);
};

/** remu: rd = rs1_u % rs2_u; ÷0 → dividend. */
const remu = (registers: Registers, _memory: Memory, args: OpArgs): void => {
  const dividend = bytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister1));
  const divisor = bytesToBigInt(readGeneralPurposeRegister(registers, args.sourceRegister2));
  const remainder = divisor === 0n ? dividend : dividend % divisor;
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    unsignedBigIntToBytes(new Uint8Array(8), remainder & MASK64)
  );
  advanceProgramCounter(registers);
};

export { mul, mulh, mulhsu, mulhu, div, divu, rem, remu };
