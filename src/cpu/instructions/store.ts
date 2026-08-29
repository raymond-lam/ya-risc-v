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

import { addBytes, bytesToNumber } from '#utils/bytes.js';
import { readGeneralPurposeRegister, advanceProgramCounter } from '#cpu/registers.js';
import type { Registers } from '#cpu/types.js';
import { storeBytes } from '#memory.js';

type StoreArgs = {
  sourceRegister1: number;
  sourceRegister2: number;
  immediate: Uint8Array;
};

const storeEffectiveAddress = (registers: Registers, args: StoreArgs): number => {
  const address = new Uint8Array(8);
  addBytes(address, readGeneralPurposeRegister(registers, args.sourceRegister1), args.immediate);
  return bytesToNumber(address);
};

/** sb: mem[rs1+imm] = rs2[7:0]. */
const sb = (registers: Registers, memory: Uint8Array, args: StoreArgs): void => {
  storeBytes({
    memory,
    address: storeEffectiveAddress(registers, args),
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 1,
  });
  advanceProgramCounter(registers);
};

/** sh: mem[rs1+imm] = rs2[15:0]. */
const sh = (registers: Registers, memory: Uint8Array, args: StoreArgs): void => {
  storeBytes({
    memory,
    address: storeEffectiveAddress(registers, args),
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 2,
  });
  advanceProgramCounter(registers);
};

/** sw: mem[rs1+imm] = rs2[31:0]. */
const sw = (registers: Registers, memory: Uint8Array, args: StoreArgs): void => {
  storeBytes({
    memory,
    address: storeEffectiveAddress(registers, args),
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 4,
  });
  advanceProgramCounter(registers);
};

/** sd: mem[rs1+imm] = rs2. */
const sd = (registers: Registers, memory: Uint8Array, args: StoreArgs): void => {
  storeBytes({
    memory,
    address: storeEffectiveAddress(registers, args),
    source: readGeneralPurposeRegister(registers, args.sourceRegister2),
    byteLength: 8,
  });
  advanceProgramCounter(registers);
};

export { sb, sh, sw, sd };
export type { StoreArgs };
