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
  low32Bytes,
  shiftLeftBytes,
  shiftRightLogicalBytes,
  shiftRightArithmeticBytes,
  signExtendLow32Bytes,
} from '#utils/bytes.js';
import {
  readGeneralPurposeRegister,
  writeGeneralPurposeRegister,
  advanceProgramCounter,
} from '#cpu/registers.js';
import type { Registers } from '#cpu/types.js';

type OpImm32Args = {
  destinationRegister: number;
  sourceRegister1: number;
  immediate: Uint8Array;
};

type ShiftImm32Args = {
  destinationRegister: number;
  sourceRegister1: number;
  shiftAmount: number;
};

/** addiw: rd = sext32(rs1[31:0] + imm). */
const addiw = (registers: Registers, _memory: Uint8Array, args: OpImm32Args): void => {
  const sum = new Uint8Array(8);
  addBytes(
    sum,
    low32Bytes(readGeneralPurposeRegister(registers, args.sourceRegister1)),
    args.immediate
  );
  const result = new Uint8Array(8);
  signExtendLow32Bytes(result, sum);
  writeGeneralPurposeRegister(registers, args.destinationRegister, result);
  advanceProgramCounter(registers);
};

/** slliw: rd = sext32(rs1[31:0] << shamt). */
const slliw = (registers: Registers, _memory: Uint8Array, args: ShiftImm32Args): void => {
  const shifted = new Uint8Array(8);
  shiftLeftBytes(
    shifted,
    low32Bytes(readGeneralPurposeRegister(registers, args.sourceRegister1)),
    args.shiftAmount
  );
  const result = new Uint8Array(8);
  signExtendLow32Bytes(result, shifted);
  writeGeneralPurposeRegister(registers, args.destinationRegister, result);
  advanceProgramCounter(registers);
};

/** srliw: rd = sext32(rs1[31:0] >> shamt) (logical). */
const srliw = (registers: Registers, _memory: Uint8Array, args: ShiftImm32Args): void => {
  const shifted = new Uint8Array(8);
  shiftRightLogicalBytes(
    shifted,
    low32Bytes(readGeneralPurposeRegister(registers, args.sourceRegister1)),
    args.shiftAmount
  );
  const result = new Uint8Array(8);
  signExtendLow32Bytes(result, shifted);
  writeGeneralPurposeRegister(registers, args.destinationRegister, result);
  advanceProgramCounter(registers);
};

/** sraiw: rd = sext32(rs1[31:0] >> shamt) (arithmetic). */
const sraiw = (registers: Registers, _memory: Uint8Array, args: ShiftImm32Args): void => {
  const extended = new Uint8Array(8);
  signExtendLow32Bytes(
    extended,
    low32Bytes(readGeneralPurposeRegister(registers, args.sourceRegister1))
  );
  const shifted = new Uint8Array(8);
  shiftRightArithmeticBytes(shifted, extended, args.shiftAmount);
  const result = new Uint8Array(8);
  signExtendLow32Bytes(result, shifted);
  writeGeneralPurposeRegister(registers, args.destinationRegister, result);
  advanceProgramCounter(registers);
};

export { addiw, slliw, srliw, sraiw };
export type { OpImm32Args, ShiftImm32Args };
