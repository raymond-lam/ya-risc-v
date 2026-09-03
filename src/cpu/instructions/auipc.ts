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
  readProgramCounter,
  advanceProgramCounter,
} from '#cpu/registers.js';
import type { Registers } from '#cpu/types.js';

type AuipcArgs = {
  destinationRegister: number;
  immediate: Uint8Array;
};

/** auipc: rd = pc + imm (U-type). */
const auipc = (registers: Registers, _memory: Uint8Array, args: AuipcArgs): void => {
  writeGeneralPurposeRegister(
    registers,
    args.destinationRegister,
    addBytes(new Uint8Array(8), readProgramCounter(registers), args.immediate)
  );
  advanceProgramCounter(registers);
};

export { auipc };
export type { AuipcArgs };
