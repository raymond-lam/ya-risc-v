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

import { andBytes, isZeroBytes, orBytes, xorBytes } from '#utils/bytes.js';
import {
  advanceProgramCounter,
  readGeneralPurposeRegister,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#cpu/registers.js';
import {
  CAUSE_BREAKPOINT,
  CAUSE_ECALL_FROM_M,
  enterTrap,
  returnFromMachineTrap,
} from '#cpu/trap.js';
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

/** ecall: environment call from M-mode (synchronous trap, cause 11). */
const ecall = (registers: Registers, _memory: Uint8Array): void => {
  enterTrap(registers, CAUSE_ECALL_FROM_M);
};

/** ebreak: breakpoint (synchronous trap, cause 3). */
const ebreak = (registers: Registers, _memory: Uint8Array): void => {
  enterTrap(registers, CAUSE_BREAKPOINT);
};

/** mret: return from M-mode trap handler. */
const mret = (registers: Registers, _memory: Uint8Array): void => {
  returnFromMachineTrap(registers);
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
    writeControlAndStatusRegister(
      registers,
      args.controlAndStatusRegister,
      orBytes(
        new Uint8Array(8),
        previous,
        readGeneralPurposeRegister(registers, args.sourceRegister1)
      )
    );
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrc: rd = csr; if rs1 ≠ x0, csr &= ~rs1. */
const csrrc = (registers: Registers, _memory: Uint8Array, args: CsrRegisterArgs): void => {
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  if (args.sourceRegister1 !== 0) {
    writeControlAndStatusRegister(
      registers,
      args.controlAndStatusRegister,
      andBytes(
        new Uint8Array(8),
        previous,
        xorBytes(
          new Uint8Array(8),
          readGeneralPurposeRegister(registers, args.sourceRegister1),
          ALL_ONES_BYTES
        )
      )
    );
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
    writeControlAndStatusRegister(
      registers,
      args.controlAndStatusRegister,
      orBytes(new Uint8Array(8), previous, args.immediate)
    );
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

/** csrrci: rd = csr; if uimm ≠ 0, csr &= ~uimm. */
const csrrci = (registers: Registers, _memory: Uint8Array, args: CsrImmediateArgs): void => {
  const previous = snapshotControlAndStatusRegister(registers, args.controlAndStatusRegister);
  if (!isZeroBytes(args.immediate)) {
    writeControlAndStatusRegister(
      registers,
      args.controlAndStatusRegister,
      andBytes(
        new Uint8Array(8),
        previous,
        xorBytes(new Uint8Array(8), args.immediate, ALL_ONES_BYTES)
      )
    );
  }
  writeGeneralPurposeRegister(registers, args.destinationRegister, previous);
  advanceProgramCounter(registers);
};

export { ecall, ebreak, mret, csrrw, csrrs, csrrc, csrrwi, csrrsi, csrrci };
export type { CsrRegisterArgs, CsrImmediateArgs };
