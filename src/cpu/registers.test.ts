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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  advanceProgramCounter,
  createRegisters,
  readControlAndStatusRegister,
  readGeneralPurposeRegister,
  readProgramCounter,
  setBooleanGeneralPurposeRegister,
  setProgramCounter,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#cpu/registers.js';
import { bytesToNumber, signedNumberToBytes } from '#utils/bytes.js';

describe('registers', () => {
  it('x0 reads as zero on reset', () => {
    const registers = createRegisters();
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 0)],
      [...signedNumberToBytes(0, 32)]
    );
  });

  it('writes and reads a general-purpose register', () => {
    const registers = createRegisters();
    const value = signedNumberToBytes(42, 32);
    writeGeneralPurposeRegister(registers, 1, value);
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), value);
  });

  it('setBooleanGeneralPurposeRegister writes 0 or 1', () => {
    const registers = createRegisters();
    setBooleanGeneralPurposeRegister(registers, 2, true);
    setBooleanGeneralPurposeRegister(registers, 3, false);
    assert.deepEqual(readGeneralPurposeRegister(registers, 2), signedNumberToBytes(1, 32));
    assert.deepEqual(readGeneralPurposeRegister(registers, 3), signedNumberToBytes(0, 32));
  });

  it('setProgramCounter and advanceProgramCounter update pc by 4', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(100, 32));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 100);
    advanceProgramCounter(registers);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 104);
  });

  it('writes and reads a control-and-status register', () => {
    const registers = createRegisters();
    const value = signedNumberToBytes(0x1234, 32);
    writeControlAndStatusRegister(registers, 0x300, value);
    assert.deepEqual(readControlAndStatusRegister(registers, 0x300), value);
  });

  it('x0 ignores writes at runtime', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 0, signedNumberToBytes(99, 32));
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 0)],
      [...signedNumberToBytes(0, 32)]
    );
  });

  it('identity CSRs ignore writes at runtime', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(registers, 0xf14, signedNumberToBytes(99, 32));
    assert.deepEqual(
      [...readControlAndStatusRegister(registers, 0xf14)],
      [...signedNumberToBytes(0, 32)]
    );
  });
});
