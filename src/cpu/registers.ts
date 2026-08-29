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

import ReadonlyUint8Array from '#ReadonlyUint8Array.js';
import type { Registers } from '#cpu/types.js';
import { addBytes, copyBytes, signedNumberToBytes } from '#utils/bytes.js';

/** Number of integer general-purpose registers (x0–x31). */
const GENERAL_PURPOSE_REGISTER_COUNT = 32;

/** CSR indices are 12-bit (0–4095); the ISA calls this the CSR address. */
const CONTROL_AND_STATUS_REGISTER_COUNT = 4096;

/** Identity CSR addresses (read-only). */
const MVENDORID = 0xf11;
const MARCHID = 0xf12;
const MIMPID = 0xf13;
const MHARTID = 0xf14;

/** The 0 and 1 that slt/slti/sltu/sltiu write to rd. */
const REGISTER_ZERO_BYTES = new ReadonlyUint8Array(8);
const REGISTER_ONE_BYTES = ReadonlyUint8Array.fromBytes(signedNumberToBytes(1, 32));

const FOUR_BYTES = ReadonlyUint8Array.fromBytes(signedNumberToBytes(4, 32));

const createRegisters = (): Registers => {
  const generalPurpose = Array.from(
    { length: GENERAL_PURPOSE_REGISTER_COUNT },
    () => new Uint8Array(8)
  );
  generalPurpose[0] = new ReadonlyUint8Array(8);

  const controlAndStatus = Array.from(
    { length: CONTROL_AND_STATUS_REGISTER_COUNT },
    () => new Uint8Array(8)
  );
  controlAndStatus[MVENDORID] = new ReadonlyUint8Array(8);
  controlAndStatus[MARCHID] = new ReadonlyUint8Array(8);
  controlAndStatus[MIMPID] = new ReadonlyUint8Array(8);
  controlAndStatus[MHARTID] = new ReadonlyUint8Array(8);

  return {
    generalPurpose: generalPurpose as unknown as Registers['generalPurpose'],
    programCounter: new Uint8Array(8),
    controlAndStatus: controlAndStatus as unknown as Registers['controlAndStatus'],
  };
};

const writeGeneralPurposeRegister = (
  registers: Registers,
  index: number,
  value: Uint8Array
): void => {
  copyBytes(registers.generalPurpose[index]!, value);
};

const readGeneralPurposeRegister = (registers: Registers, index: number): Uint8Array =>
  registers.generalPurpose[index]!;

const setBooleanGeneralPurposeRegister = (
  registers: Registers,
  index: number,
  condition: boolean
): void => {
  writeGeneralPurposeRegister(
    registers,
    index,
    condition ? REGISTER_ONE_BYTES : REGISTER_ZERO_BYTES
  );
};

const readProgramCounter = (registers: Registers): Uint8Array => registers.programCounter;

const setProgramCounter = (registers: Registers, value: Uint8Array): void => {
  copyBytes(registers.programCounter, value);
};

const advanceProgramCounter = (registers: Registers): void => {
  addBytes(registers.programCounter, registers.programCounter, FOUR_BYTES);
};

const readControlAndStatusRegister = (registers: Registers, index: number): Uint8Array =>
  registers.controlAndStatus[index]!;

const writeControlAndStatusRegister = (
  registers: Registers,
  index: number,
  value: Uint8Array
): void => {
  copyBytes(registers.controlAndStatus[index]!, value);
};

export {
  GENERAL_PURPOSE_REGISTER_COUNT,
  CONTROL_AND_STATUS_REGISTER_COUNT,
  FOUR_BYTES,
  createRegisters,
  writeGeneralPurposeRegister,
  readGeneralPurposeRegister,
  setBooleanGeneralPurposeRegister,
  readProgramCounter,
  setProgramCounter,
  advanceProgramCounter,
  readControlAndStatusRegister,
  writeControlAndStatusRegister,
};
