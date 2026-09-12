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

import { writeGeneralPurposeRegister, advanceProgramCounter } from '#cpu/registers';
import type { Registers } from '#cpu/types';
import type { Memory, ReadonlyUint8Array } from '#memory';

type LuiArgs = {
  destinationRegister: number;
  immediate: ReadonlyUint8Array;
};

/** lui: rd = imm (U-type). */
const lui = (registers: Registers, _memory: Memory, args: LuiArgs): void => {
  writeGeneralPurposeRegister(registers, args.destinationRegister, args.immediate);
  advanceProgramCounter(registers);
};

export { lui };
export type { LuiArgs };
