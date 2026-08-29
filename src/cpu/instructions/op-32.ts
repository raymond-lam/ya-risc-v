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
  subtractBytes,
  low32Bytes,
  byte0ToNumber,
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

type Op32Args = {
  destinationRegister: number;
  sourceRegister1: number;
  sourceRegister2: number;
};

/** addw: rd = sext32(rs1[31:0] + rs2[31:0]). */
const addw = (registers: Registers, _memory: Uint8Array, args: Op32Args): void => {
  const sum = new Uint8Array(8);
  addBytes(
    sum,
    low32Bytes(readGeneralPurposeRegister(registers, args.sourceRegister1)),
    low32Bytes(readGeneralPurposeRegister(registers, args.sourceRegister2))
  );
  const result = new Uint8Array(8);
  signExtendLow32Bytes(result, sum);
  writeGeneralPurposeRegister(registers, args.destinationRegister, result);
  advanceProgramCounter(registers);
};

/** subw: rd = sext32(rs1[31:0] - rs2[31:0]). */
const subw = (registers: Registers, _memory: Uint8Array, args: Op32Args): void => {
  const difference = new Uint8Array(8);
  subtractBytes(
    difference,
    low32Bytes(readGeneralPurposeRegister(registers, args.sourceRegister1)),
    low32Bytes(readGeneralPurposeRegister(registers, args.sourceRegister2))
  );
  const result = new Uint8Array(8);
  signExtendLow32Bytes(result, difference);
  writeGeneralPurposeRegister(registers, args.destinationRegister, result);
  advanceProgramCounter(registers);
};

/** sllw: rd = sext32(rs1[31:0] << rs2). */
const sllw = (registers: Registers, _memory: Uint8Array, args: Op32Args): void => {
  const shifted = new Uint8Array(8);
  shiftLeftBytes(
    shifted,
    low32Bytes(readGeneralPurposeRegister(registers, args.sourceRegister1)),
    byte0ToNumber(readGeneralPurposeRegister(registers, args.sourceRegister2), 0x1f)
  );
  const result = new Uint8Array(8);
  signExtendLow32Bytes(result, shifted);
  writeGeneralPurposeRegister(registers, args.destinationRegister, result);
  advanceProgramCounter(registers);
};

/** srlw: rd = sext32(rs1[31:0] >> rs2) (logical). */
const srlw = (registers: Registers, _memory: Uint8Array, args: Op32Args): void => {
  const shifted = new Uint8Array(8);
  shiftRightLogicalBytes(
    shifted,
    low32Bytes(readGeneralPurposeRegister(registers, args.sourceRegister1)),
    byte0ToNumber(readGeneralPurposeRegister(registers, args.sourceRegister2), 0x1f)
  );
  const result = new Uint8Array(8);
  signExtendLow32Bytes(result, shifted);
  writeGeneralPurposeRegister(registers, args.destinationRegister, result);
  advanceProgramCounter(registers);
};

/** sraw: rd = sext32(rs1[31:0] >> rs2) (arithmetic). */
const sraw = (registers: Registers, _memory: Uint8Array, args: Op32Args): void => {
  const extended = new Uint8Array(8);
  signExtendLow32Bytes(
    extended,
    low32Bytes(readGeneralPurposeRegister(registers, args.sourceRegister1))
  );
  const shifted = new Uint8Array(8);
  shiftRightArithmeticBytes(
    shifted,
    extended,
    byte0ToNumber(readGeneralPurposeRegister(registers, args.sourceRegister2), 0x1f)
  );
  const result = new Uint8Array(8);
  signExtendLow32Bytes(result, shifted);
  writeGeneralPurposeRegister(registers, args.destinationRegister, result);
  advanceProgramCounter(registers);
};

export { addw, subw, sllw, srlw, sraw };
export type { Op32Args };
