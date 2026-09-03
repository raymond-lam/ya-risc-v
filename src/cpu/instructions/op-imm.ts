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
  orBytes,
  xorBytes,
  compareSignedBytes,
  compareUnsignedBytes,
  shiftLeftBytes,
  shiftRightLogicalBytes,
  shiftRightArithmeticBytes,
} from '#utils/bytes.js';
import {
  readGeneralPurposeRegister,
  writeGeneralPurposeRegister,
  setBooleanGeneralPurposeRegister,
  advanceProgramCounter,
} from '#cpu/registers.js';
import type { Registers } from '#cpu/types.js';

type OpImmArgs = {
  destinationRegister: number;
  sourceRegister1: number;
  immediate: Uint8Array;
};

type ShiftImmArgs = {
  destinationRegister: number;
  sourceRegister1: number;
  shiftAmount: number;
};

/** addi: rd = rs1 + imm. */
const addi = (registers: Registers, _memory: Uint8Array, args: OpImmArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    addBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      args.immediate
    )
  );
  advanceProgramCounter(registers);
};

/** slti: rd = (rs1 < imm) ? 1 : 0 (signed). */
const slti = (registers: Registers, _memory: Uint8Array, args: OpImmArgs): void => {
  setBooleanGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    compareSignedBytes(
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      args.immediate
    ) < 0
  );
  advanceProgramCounter(registers);
};

/** sltiu: rd = (rs1 < imm) ? 1 : 0 (unsigned). */
const sltiu = (registers: Registers, _memory: Uint8Array, args: OpImmArgs): void => {
  setBooleanGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    compareUnsignedBytes(
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      args.immediate
    ) < 0
  );
  advanceProgramCounter(registers);
};

/** xori: rd = rs1 ^ imm. */
const xori = (registers: Registers, _memory: Uint8Array, args: OpImmArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    xorBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      args.immediate
    )
  );
  advanceProgramCounter(registers);
};

/** ori: rd = rs1 | imm. */
const ori = (registers: Registers, _memory: Uint8Array, args: OpImmArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    orBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      args.immediate
    )
  );
  advanceProgramCounter(registers);
};

/** andi: rd = rs1 & imm. */
const andi = (registers: Registers, _memory: Uint8Array, args: OpImmArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    andBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      args.immediate
    )
  );
  advanceProgramCounter(registers);
};

/** slli: rd = rs1 << shamt. */
const slli = (registers: Registers, _memory: Uint8Array, args: ShiftImmArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    shiftLeftBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      args.shiftAmount
    )
  );
  advanceProgramCounter(registers);
};

/** srli: rd = rs1 >> shamt (logical). */
const srli = (registers: Registers, _memory: Uint8Array, args: ShiftImmArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    shiftRightLogicalBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      args.shiftAmount
    )
  );
  advanceProgramCounter(registers);
};

/** srai: rd = rs1 >> shamt (arithmetic). */
const srai = (registers: Registers, _memory: Uint8Array, args: ShiftImmArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    shiftRightArithmeticBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      args.shiftAmount
    )
  );
  advanceProgramCounter(registers);
};

export { addi, slti, sltiu, xori, ori, andi, slli, srli, srai };
export type { OpImmArgs, ShiftImmArgs };
