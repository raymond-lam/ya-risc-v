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

import { addBytes, compareSignedBytes, compareUnsignedBytes } from '#utils/bytes.js';
import {
  readGeneralPurposeRegister,
  readProgramCounter,
  setProgramCounter,
  advanceProgramCounter,
} from '#cpu/registers.js';
import type { Registers } from '#cpu/types.js';

type BranchArgs = {
  sourceRegister1: number;
  sourceRegister2: number;
  immediate: Uint8Array;
};

const takeBranch = (registers: Registers, immediate: Uint8Array): void => {
  setProgramCounter(
    registers,
    addBytes(new Uint8Array(8), readProgramCounter(registers), immediate)
  );
};

/** beq: branch if rs1 == rs2. */
const beq = (registers: Registers, _memory: Uint8Array, args: BranchArgs): void => {
  if (
    compareUnsignedBytes(
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    ) === 0
  ) {
    takeBranch(registers, args.immediate);
  } else {
    advanceProgramCounter(registers);
  }
};

/** bne: branch if rs1 != rs2. */
const bne = (registers: Registers, _memory: Uint8Array, args: BranchArgs): void => {
  if (
    compareUnsignedBytes(
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    ) !== 0
  ) {
    takeBranch(registers, args.immediate);
  } else {
    advanceProgramCounter(registers);
  }
};

/** blt: branch if rs1 < rs2 (signed). */
const blt = (registers: Registers, _memory: Uint8Array, args: BranchArgs): void => {
  if (
    compareSignedBytes(
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    ) < 0
  ) {
    takeBranch(registers, args.immediate);
  } else {
    advanceProgramCounter(registers);
  }
};

/** bge: branch if rs1 >= rs2 (signed). */
const bge = (registers: Registers, _memory: Uint8Array, args: BranchArgs): void => {
  if (
    compareSignedBytes(
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    ) >= 0
  ) {
    takeBranch(registers, args.immediate);
  } else {
    advanceProgramCounter(registers);
  }
};

/** bltu: branch if rs1 < rs2 (unsigned). */
const bltu = (registers: Registers, _memory: Uint8Array, args: BranchArgs): void => {
  if (
    compareUnsignedBytes(
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    ) < 0
  ) {
    takeBranch(registers, args.immediate);
  } else {
    advanceProgramCounter(registers);
  }
};

/** bgeu: branch if rs1 >= rs2 (unsigned). */
const bgeu = (registers: Registers, _memory: Uint8Array, args: BranchArgs): void => {
  if (
    compareUnsignedBytes(
      readGeneralPurposeRegister(registers, args.sourceRegister1),
      readGeneralPurposeRegister(registers, args.sourceRegister2)
    ) >= 0
  ) {
    takeBranch(registers, args.immediate);
  } else {
    advanceProgramCounter(registers);
  }
};

export { beq, bne, blt, bge, bltu, bgeu };
export type { BranchArgs };
