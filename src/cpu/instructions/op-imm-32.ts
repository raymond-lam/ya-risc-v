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
  signExtendBytes,
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
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    signExtendBytes(
      addBytes(
        new Uint8Array(8),
        low32Bytes(new Uint8Array(8), readGeneralPurposeRegister(registers, args.sourceRegister1)),
        args.immediate
      ),
      4
    )
  );
  advanceProgramCounter(registers);
};

/** slliw: rd = sext32(rs1[31:0] << shamt). */
const slliw = (registers: Registers, _memory: Uint8Array, args: ShiftImm32Args): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    signExtendBytes(
      shiftLeftBytes(
        new Uint8Array(8),
        low32Bytes(new Uint8Array(8), readGeneralPurposeRegister(registers, args.sourceRegister1)),
        args.shiftAmount
      ),
      4
    )
  );
  advanceProgramCounter(registers);
};

/** srliw: rd = sext32(rs1[31:0] >> shamt) (logical). */
const srliw = (registers: Registers, _memory: Uint8Array, args: ShiftImm32Args): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    signExtendBytes(
      shiftRightLogicalBytes(
        new Uint8Array(8),
        low32Bytes(new Uint8Array(8), readGeneralPurposeRegister(registers, args.sourceRegister1)),
        args.shiftAmount
      ),
      4
    )
  );
  advanceProgramCounter(registers);
};

/** sraiw: rd = sext32(rs1[31:0] >> shamt) (arithmetic). */
const sraiw = (registers: Registers, _memory: Uint8Array, args: ShiftImm32Args): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    signExtendBytes(
      shiftRightArithmeticBytes(
        new Uint8Array(8),
        signExtendBytes(
          low32Bytes(
            new Uint8Array(8),
            readGeneralPurposeRegister(registers, args.sourceRegister1)
          ),
          4
        ),
        args.shiftAmount
      ),
      4
    )
  );
  advanceProgramCounter(registers);
};

export { addiw, slliw, srliw, sraiw };
export type { OpImm32Args, ShiftImm32Args };
