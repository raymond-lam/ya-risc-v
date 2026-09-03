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
  andBytes,
  orBytes,
  xorBytes,
  compareSignedBytes,
  compareUnsignedBytes,
  byte0ToNumber,
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

type OpArgs = {
  destinationRegister: number;
  sourceRegister1: number;
  sourceRegister2: number;
};

/** add: rd = rs1 + rs2. */
const add = (registers: Registers, _memory: Uint8Array, args: OpArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    addBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    )
  );
  advanceProgramCounter(registers);
};

/** sub: rd = rs1 - rs2. */
const sub = (registers: Registers, _memory: Uint8Array, args: OpArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    subtractBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    )
  );
  advanceProgramCounter(registers);
};

/** sll: rd = rs1 << rs2. */
const sll = (registers: Registers, _memory: Uint8Array, args: OpArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    shiftLeftBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      byte0ToNumber(readGeneralPurposeRegister(registers, args.sourceRegister2), 0x3f)
    )
  );
  advanceProgramCounter(registers);
};

/** slt: rd = (rs1 < rs2) ? 1 : 0 (signed). */
const slt = (registers: Registers, _memory: Uint8Array, args: OpArgs): void => {
  setBooleanGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    compareSignedBytes(
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    ) < 0
  );
  advanceProgramCounter(registers);
};

/** sltu: rd = (rs1 < rs2) ? 1 : 0 (unsigned). */
const sltu = (registers: Registers, _memory: Uint8Array, args: OpArgs): void => {
  setBooleanGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    compareUnsignedBytes(
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    ) < 0
  );
  advanceProgramCounter(registers);
};

/** xor: rd = rs1 ^ rs2. */
const xor = (registers: Registers, _memory: Uint8Array, args: OpArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    xorBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    )
  );
  advanceProgramCounter(registers);
};

/** srl: rd = rs1 >> rs2 (logical). */
const srl = (registers: Registers, _memory: Uint8Array, args: OpArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    shiftRightLogicalBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      byte0ToNumber(readGeneralPurposeRegister(registers, args.sourceRegister2), 0x3f)
    )
  );
  advanceProgramCounter(registers);
};

/** sra: rd = rs1 >> rs2 (arithmetic). */
const sra = (registers: Registers, _memory: Uint8Array, args: OpArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    shiftRightArithmeticBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      byte0ToNumber(readGeneralPurposeRegister(registers, args.sourceRegister2), 0x3f)
    )
  );
  advanceProgramCounter(registers);
};

/** or: rd = rs1 | rs2. */
const or = (registers: Registers, _memory: Uint8Array, args: OpArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    orBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    )
  );
  advanceProgramCounter(registers);
};

/** and: rd = rs1 & rs2. */
const and = (registers: Registers, _memory: Uint8Array, args: OpArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    andBytes(
      new Uint8Array(8),
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    )
  );
  advanceProgramCounter(registers);
};

export { add, sub, sll, slt, sltu, xor, srl, sra, or, and };
export type { OpArgs };
