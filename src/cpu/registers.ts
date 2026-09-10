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

import type { Registers } from '#cpu/types.js';
import { addBytes, copyBytes, signedNumberToBytes } from '#utils/bytes.js';
import type { ReadonlyUint8Array } from '#types.js';

/** Number of integer general-purpose registers (x0–x31). */
const GENERAL_PURPOSE_REGISTER_COUNT = 32;

/** CSR indices are 12-bit (0–4095); the ISA calls this the CSR address. */
const CONTROL_AND_STATUS_REGISTER_COUNT = 4096;

/** Machine-mode CSRs used by trap entry and `mret`. */
const MSTATUS = 0x300;
const MTVEC = 0x305;
const MEPC = 0x341;
const MCAUSE = 0x342;
const MTVAL = 0x343;

/** Identity CSR addresses (implemented read-only). */
const MVENDORID = 0xf11;
const MARCHID = 0xf12;
const MIMPID = 0xf13;
const MHARTID = 0xf14;

const isIdentityControlAndStatusRegister = (index: number): boolean =>
  index === MVENDORID || index === MARCHID || index === MIMPID || index === MHARTID;

const isImplementedControlAndStatusRegister = (index: number): boolean =>
  index === MSTATUS ||
  index === MTVEC ||
  index === MEPC ||
  index === MCAUSE ||
  index === MTVAL ||
  isIdentityControlAndStatusRegister(index);

const isReadOnlyControlAndStatusRegister = (index: number): boolean =>
  isIdentityControlAndStatusRegister(index);

/**
 * Whether a CSR instruction may complete. Non-existent indices are illegal on any
 * access; read-only CSRs are illegal only when the instruction would write.
 */
const isControlAndStatusRegisterAccessAllowed = (index: number, writes: boolean): boolean => {
  if (!isImplementedControlAndStatusRegister(index)) {
    return false;
  }
  if (writes && isReadOnlyControlAndStatusRegister(index)) {
    return false;
  }
  return true;
};

/** The 0 and 1 that slt/slti/sltu/sltiu write to rd. */
const REGISTER_ZERO_BYTES = new Uint8Array(8) as ReadonlyUint8Array;
const REGISTER_ONE_BYTES = signedNumberToBytes(new Uint8Array(8), 1, 32) as ReadonlyUint8Array;

const FOUR_BYTES = signedNumberToBytes(new Uint8Array(8), 4, 32) as ReadonlyUint8Array;

const createRegisters = (): Registers => {
  const generalPurpose = Array.from(
    { length: GENERAL_PURPOSE_REGISTER_COUNT },
    () => new Uint8Array(8)
  );

  const controlAndStatus = Array.from(
    { length: CONTROL_AND_STATUS_REGISTER_COUNT },
    () => new Uint8Array(8)
  );

  return {
    generalPurpose: generalPurpose as unknown as Registers['generalPurpose'],
    programCounter: new Uint8Array(8),
    controlAndStatus: controlAndStatus as unknown as Registers['controlAndStatus'],
  };
};

const writeGeneralPurposeRegister = (
  registers: Registers,
  index: number,
  value: ReadonlyUint8Array
): ReadonlyUint8Array => {
  // x0 is hardwired zero: architectural writes are ignored.
  if (index === 0) {
    return registers.generalPurpose[0];
  }
  return copyBytes(registers.generalPurpose[index]!, value);
};

const readGeneralPurposeRegister = (registers: Registers, index: number): ReadonlyUint8Array =>
  registers.generalPurpose[index]!;

const setBooleanGeneralPurposeRegister = (
  registers: Registers,
  index: number,
  condition: boolean
): ReadonlyUint8Array =>
  writeGeneralPurposeRegister(
    registers,
    index,
    condition ? REGISTER_ONE_BYTES : REGISTER_ZERO_BYTES
  );

const readProgramCounter = (registers: Registers): ReadonlyUint8Array => registers.programCounter;

const setProgramCounter = (registers: Registers, value: ReadonlyUint8Array): Uint8Array =>
  copyBytes(registers.programCounter, value);

const advanceProgramCounter = (registers: Registers): Uint8Array =>
  addBytes(registers.programCounter, registers.programCounter, FOUR_BYTES);

const readControlAndStatusRegister = (registers: Registers, index: number): ReadonlyUint8Array =>
  registers.controlAndStatus[index]!;

/** Copy a CSR; the file slot is live and must not be used as a mutable old value. */
const snapshotControlAndStatusRegister = (registers: Registers, index: number): Uint8Array =>
  copyBytes(new Uint8Array(8), readControlAndStatusRegister(registers, index));

const writeControlAndStatusRegister = (
  registers: Registers,
  index: number,
  value: ReadonlyUint8Array
): ReadonlyUint8Array => {
  // Identity CSRs are hardwired; guest CSR instructions must trap before calling this.
  if (isIdentityControlAndStatusRegister(index)) {
    return registers.controlAndStatus[index]!;
  }
  return copyBytes(registers.controlAndStatus[index]!, value);
};

export {
  MSTATUS,
  MTVEC,
  MEPC,
  MCAUSE,
  MTVAL,
  FOUR_BYTES,
  createRegisters,
  writeGeneralPurposeRegister,
  readGeneralPurposeRegister,
  setBooleanGeneralPurposeRegister,
  readProgramCounter,
  setProgramCounter,
  advanceProgramCounter,
  readControlAndStatusRegister,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  isControlAndStatusRegisterAccessAllowed,
};
