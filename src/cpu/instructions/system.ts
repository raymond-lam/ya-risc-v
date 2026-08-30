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

import { andBytes, copyBytes, isZeroBytes, orBytes, xorBytes } from '#utils/bytes.js';
import {
  advanceProgramCounter,
  readControlAndStatusRegister,
  readGeneralPurposeRegister,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#cpu/registers.js';
import type { Registers } from '#cpu/types.js';

type CsrRegisterArgs = {
  destinationRegister: number;
  sourceRegister1: number;
  controlAndStatusRegister: number;
};

type CsrImmediateArgs = {
  destinationRegister: number;
  immediate: Uint8Array;
  controlAndStatusRegister: number;
};

const ALL_ONES_BYTES = new Uint8Array(8).fill(0xff);

/** Snapshot a CSR; the file slot is live and must not be used as the old value. */
const snapshotControlAndStatusRegister = (
  registers: Registers,
  controlAndStatusRegister: number
): Uint8Array => {
  const previous = new Uint8Array(8);
  copyBytes(previous, readControlAndStatusRegister(registers, controlAndStatusRegister));
  return previous;
};

/** ecall: environment call. */
const ecall = (_registers: Registers, _memory: Uint8Array): void => {
  throw new Error('Environment call from the ECALL instruction.');
};

/** ebreak: breakpoint. */
const ebreak = (_registers: Registers, _memory: Uint8Array): void => {
  throw new Error('Breakpoint from the EBREAK instruction.');
};

/** csrrw: rd = csr; csr = rs1. */
const csrrw = (registers: Registers, _memory: Uint8Array, args: CsrRegisterArgs): void => {
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  writeControlAndStatusRegister(
    registers,
    args.controlAndStatusRegister,
    readGeneralPurposeRegister(registers, args.sourceRegister1)
  );
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrs: rd = csr; if rs1 ≠ x0, csr |= rs1. */
const csrrs = (registers: Registers, _memory: Uint8Array, args: CsrRegisterArgs): void => {
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  if (args.sourceRegister1 !== 0) {
    const result = new Uint8Array(8);
    orBytes(result, previous, readGeneralPurposeRegister(registers, args.sourceRegister1));
    writeControlAndStatusRegister(registers, args.controlAndStatusRegister, result);
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrc: rd = csr; if rs1 ≠ x0, csr &= ~rs1. */
const csrrc = (registers: Registers, _memory: Uint8Array, args: CsrRegisterArgs): void => {
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  if (args.sourceRegister1 !== 0) {
    const inverted = new Uint8Array(8);
    xorBytes(inverted, readGeneralPurposeRegister(registers, args.sourceRegister1), ALL_ONES_BYTES);
    const result = new Uint8Array(8);
    andBytes(result, previous, inverted);
    writeControlAndStatusRegister(registers, args.controlAndStatusRegister, result);
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrwi: rd = csr; csr = zero-extended uimm. */
const csrrwi = (registers: Registers, _memory: Uint8Array, args: CsrImmediateArgs): void => {
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  writeControlAndStatusRegister(registers, args.controlAndStatusRegister, args.immediate);
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrsi: rd = csr; if uimm ≠ 0, csr |= uimm. */
const csrrsi = (registers: Registers, _memory: Uint8Array, args: CsrImmediateArgs): void => {
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  if (!isZeroBytes(args.immediate)) {
    const result = new Uint8Array(8);
    orBytes(result, previous, args.immediate);
    writeControlAndStatusRegister(registers, args.controlAndStatusRegister, result);
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrci: rd = csr; if uimm ≠ 0, csr &= ~uimm. */
const csrrci = (registers: Registers, _memory: Uint8Array, args: CsrImmediateArgs): void => {
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  if (!isZeroBytes(args.immediate)) {
    const inverted = new Uint8Array(8);
    xorBytes(inverted, args.immediate, ALL_ONES_BYTES);
    const result = new Uint8Array(8);
    andBytes(result, previous, inverted);
    writeControlAndStatusRegister(registers, args.controlAndStatusRegister, result);
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

export { ecall, ebreak, csrrw, csrrs, csrrc, csrrwi, csrrsi, csrrci };
export type { CsrRegisterArgs, CsrImmediateArgs };
