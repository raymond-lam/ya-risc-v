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

import { bytesToBigInt, low32Bytes, signExtendBytes, unsignedBigIntToBytes } from '#utils/bytes';
import {
  readGeneralPurposeRegister,
  writeGeneralPurposeRegister,
  advanceProgramCounter,
} from '#emulator/cpu/registers';
import type { Op32Args } from '#emulator/cpu/instructions/op-32';
import type { Registers } from '#emulator/cpu/types';
import type { Memory } from '#emulator/memory';

const MASK32 = 0xffff_ffffn;
const SIGNED32_MIN = -0x8000_0000n;

const low32Unsigned = (registers: Registers, registerIndex: number): bigint =>
  bytesToBigInt(
    low32Bytes(new Uint8Array(8), readGeneralPurposeRegister(registers, registerIndex))
  ) & MASK32;

const low32Signed = (registers: Registers, registerIndex: number): bigint => {
  const unsigned = low32Unsigned(registers, registerIndex);
  return unsigned >= 0x8000_0000n ? unsigned - 0x1_0000_0000n : unsigned;
};

const writeSext32 = (registers: Registers, destinationRegister: number, value: bigint): void => {
  writeGeneralPurposeRegister(
    registers,
    destinationRegister,
    signExtendBytes(unsignedBigIntToBytes(new Uint8Array(8), value & MASK32), 4)
  );
};

/** mulw: rd = sext32(rs1[31:0] × rs2[31:0]). */
const mulw = (registers: Registers, _memory: Memory, args: Op32Args): void => {
  writeSext32(
    registers,
    args.destinationRegister,
    low32Signed(registers, args.sourceRegister1) * low32Signed(registers, args.sourceRegister2)
  );
  advanceProgramCounter(registers);
};

/** divw: rd = sext32(rs1[31:0]_s ÷ rs2[31:0]_s); ÷0 → −1; overflow → dividend. */
const divw = (registers: Registers, _memory: Memory, args: Op32Args): void => {
  const dividend = low32Signed(registers, args.sourceRegister1);
  const divisor = low32Signed(registers, args.sourceRegister2);
  let quotient: bigint;
  if (divisor === 0n) {
    quotient = -1n;
  } else if (dividend === SIGNED32_MIN && divisor === -1n) {
    quotient = dividend;
  } else {
    quotient = dividend / divisor;
  }
  writeSext32(registers, args.destinationRegister, quotient);
  advanceProgramCounter(registers);
};

/** divuw: rd = sext32(rs1[31:0]_u ÷ rs2[31:0]_u); ÷0 → all ones. */
const divuw = (registers: Registers, _memory: Memory, args: Op32Args): void => {
  const dividend = low32Unsigned(registers, args.sourceRegister1);
  const divisor = low32Unsigned(registers, args.sourceRegister2);
  const quotient = divisor === 0n ? MASK32 : dividend / divisor;
  writeSext32(registers, args.destinationRegister, quotient);
  advanceProgramCounter(registers);
};

/** remw: rd = sext32(rs1[31:0]_s % rs2[31:0]_s); ÷0 → dividend; overflow → 0. */
const remw = (registers: Registers, _memory: Memory, args: Op32Args): void => {
  const dividend = low32Signed(registers, args.sourceRegister1);
  const divisor = low32Signed(registers, args.sourceRegister2);
  let remainder: bigint;
  if (divisor === 0n) {
    remainder = dividend;
  } else if (dividend === SIGNED32_MIN && divisor === -1n) {
    remainder = 0n;
  } else {
    remainder = dividend % divisor;
  }
  writeSext32(registers, args.destinationRegister, remainder);
  advanceProgramCounter(registers);
};

/** remuw: rd = sext32(rs1[31:0]_u % rs2[31:0]_u); ÷0 → dividend. */
const remuw = (registers: Registers, _memory: Memory, args: Op32Args): void => {
  const dividend = low32Unsigned(registers, args.sourceRegister1);
  const divisor = low32Unsigned(registers, args.sourceRegister2);
  const remainder = divisor === 0n ? dividend : dividend % divisor;
  writeSext32(registers, args.destinationRegister, remainder);
  advanceProgramCounter(registers);
};

export { mulw, divw, divuw, remw, remuw };
