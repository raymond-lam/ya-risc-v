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

import { addBytes, signExtendBytes, zeroExtendBytes } from '#utils/bytes.js';
import {
  readGeneralPurposeRegister,
  writeGeneralPurposeRegister,
  advanceProgramCounter,
} from '#cpu/registers.js';
import type { Registers } from '#cpu/types.js';
import { loadBytes } from '#memory.js';

type LoadArgs = {
  destinationRegister: number;
  sourceRegister1: number;
  immediate: Uint8Array;
};

const loadEffectiveAddress = (registers: Registers, args: LoadArgs): Uint8Array =>
  addBytes(
    new Uint8Array(8),
    readGeneralPurposeRegister(registers, args.sourceRegister1),
    args.immediate
  );

/** lb: rd = sext(mem[rs1+imm], 8). */
const lb = (registers: Registers, memory: Uint8Array, args: LoadArgs): void => {
  const loaded = new Uint8Array(8);
  loadBytes({
    destination: loaded,
    memory,
    address: loadEffectiveAddress(registers, args),
    byteLength: 1,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, signExtendBytes(loaded, 1));
  advanceProgramCounter(registers);
};

/** lh: rd = sext(mem[rs1+imm], 16). */
const lh = (registers: Registers, memory: Uint8Array, args: LoadArgs): void => {
  const loaded = new Uint8Array(8);
  loadBytes({
    destination: loaded,
    memory,
    address: loadEffectiveAddress(registers, args),
    byteLength: 2,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, signExtendBytes(loaded, 2));
  advanceProgramCounter(registers);
};

/** lw: rd = sext(mem[rs1+imm], 32). */
const lw = (registers: Registers, memory: Uint8Array, args: LoadArgs): void => {
  const loaded = new Uint8Array(8);
  loadBytes({
    destination: loaded,
    memory,
    address: loadEffectiveAddress(registers, args),
    byteLength: 4,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, signExtendBytes(loaded, 4));
  advanceProgramCounter(registers);
};

/** ld: rd = mem[rs1+imm] (64 bits). */
const ld = (registers: Registers, memory: Uint8Array, args: LoadArgs): void => {
  const loaded = new Uint8Array(8);
  loadBytes({
    destination: loaded,
    memory,
    address: loadEffectiveAddress(registers, args),
    byteLength: 8,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, loaded);
  advanceProgramCounter(registers);
};

/** lbu: rd = zext(mem[rs1+imm], 8). */
const lbu = (registers: Registers, memory: Uint8Array, args: LoadArgs): void => {
  const loaded = new Uint8Array(8);
  loadBytes({
    destination: loaded,
    memory,
    address: loadEffectiveAddress(registers, args),
    byteLength: 1,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, zeroExtendBytes(loaded, 1));
  advanceProgramCounter(registers);
};

/** lhu: rd = zext(mem[rs1+imm], 16). */
const lhu = (registers: Registers, memory: Uint8Array, args: LoadArgs): void => {
  const loaded = new Uint8Array(8);
  loadBytes({
    destination: loaded,
    memory,
    address: loadEffectiveAddress(registers, args),
    byteLength: 2,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, zeroExtendBytes(loaded, 2));
  advanceProgramCounter(registers);
};

/** lwu: rd = zext(mem[rs1+imm], 32). */
const lwu = (registers: Registers, memory: Uint8Array, args: LoadArgs): void => {
  const loaded = new Uint8Array(8);
  loadBytes({
    destination: loaded,
    memory,
    address: loadEffectiveAddress(registers, args),
    byteLength: 4,
  });
  writeGeneralPurposeRegister(registers, args.destinationRegister, zeroExtendBytes(loaded, 4));
  advanceProgramCounter(registers);
};

export { lb, lh, lw, ld, lbu, lhu, lwu };
export type { LoadArgs };
