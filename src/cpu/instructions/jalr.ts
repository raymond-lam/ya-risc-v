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

import { addBytes } from '#utils/bytes.js';
import {
  writeGeneralPurposeRegister,
  readGeneralPurposeRegister,
  readProgramCounter,
  setProgramCounter,
  FOUR_BYTES,
} from '#cpu/registers.js';
import type { Registers } from '#cpu/types.js';

type JalrArgs = {
  destinationRegister: number;
  sourceRegister1: number;
  immediate: Uint8Array;
};

/** jalr: rd = pc + 4; pc = (rs1 + imm) & ~1 (I-type). */
const jalr = (registers: Registers, _memory: Uint8Array, args: JalrArgs): void => {
  const target = new Uint8Array(8);
  addBytes(target, readGeneralPurposeRegister(registers, args.sourceRegister1), args.immediate);
  target[0] = (target[0] ?? 0) & 0xfe;
  const link = new Uint8Array(8);
  addBytes(link, readProgramCounter(registers), FOUR_BYTES);
  writeGeneralPurposeRegister(registers, args.destinationRegister, link);
  setProgramCounter(registers, target);
};

export { jalr };
export type { JalrArgs };
