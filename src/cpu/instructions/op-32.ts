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
  signExtendBytes,
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
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    signExtendBytes(
      addBytes(
        new Uint8Array(8),
        low32Bytes(new Uint8Array(8), readGeneralPurposeRegister(registers, args.sourceRegister1)),
        low32Bytes(new Uint8Array(8), readGeneralPurposeRegister(registers, args.sourceRegister2))
      ),
      4
    )
  );
  advanceProgramCounter(registers);
};

/** subw: rd = sext32(rs1[31:0] - rs2[31:0]). */
const subw = (registers: Registers, _memory: Uint8Array, args: Op32Args): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    signExtendBytes(
      subtractBytes(
        new Uint8Array(8),
        low32Bytes(new Uint8Array(8), readGeneralPurposeRegister(registers, args.sourceRegister1)),
        low32Bytes(new Uint8Array(8), readGeneralPurposeRegister(registers, args.sourceRegister2))
      ),
      4
    )
  );
  advanceProgramCounter(registers);
};

/** sllw: rd = sext32(rs1[31:0] << rs2). */
const sllw = (registers: Registers, _memory: Uint8Array, args: Op32Args): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    signExtendBytes(
      shiftLeftBytes(
        new Uint8Array(8),
        low32Bytes(new Uint8Array(8), readGeneralPurposeRegister(registers, args.sourceRegister1)),
        byte0ToNumber(readGeneralPurposeRegister(registers, args.sourceRegister2), 0x1f)
      ),
      4
    )
  );
  advanceProgramCounter(registers);
};

/** srlw: rd = sext32(rs1[31:0] >> rs2) (logical). */
const srlw = (registers: Registers, _memory: Uint8Array, args: Op32Args): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    signExtendBytes(
      shiftRightLogicalBytes(
        new Uint8Array(8),
        low32Bytes(new Uint8Array(8), readGeneralPurposeRegister(registers, args.sourceRegister1)),
        byte0ToNumber(readGeneralPurposeRegister(registers, args.sourceRegister2), 0x1f)
      ),
      4
    )
  );
  advanceProgramCounter(registers);
};

/** sraw: rd = sext32(rs1[31:0] >> rs2) (arithmetic). */
const sraw = (registers: Registers, _memory: Uint8Array, args: Op32Args): void => {
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
        byte0ToNumber(readGeneralPurposeRegister(registers, args.sourceRegister2), 0x1f)
      ),
      4
    )
  );
  advanceProgramCounter(registers);
};

export { addw, subw, sllw, srlw, sraw };
export type { Op32Args };
