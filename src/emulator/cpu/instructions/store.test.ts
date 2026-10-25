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
import testMemory from '#test/guest-memory';
import { sb, sd, sw } from '#emulator/cpu/instructions/store';
import {
  createRegisters,
  readProgramCounter,
  setProgramCounter,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
  FOUR_BYTES,
  MEPC,
  MCAUSE,
  MTVAL,
  MTVEC,
} from '#emulator/cpu/registers';
import { CAUSE_STORE_AMO_ACCESS_FAULT } from '#emulator/cpu/trap';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

describe('store', () => {
  it('sb stores the low byte', () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 3, signedNumberToBytes(new Uint8Array(8), 0xab, 32));
    writeGeneralPurposeRegister(registers, 4, signedNumberToBytes(new Uint8Array(8), 20, 32));
    sb(
      registers,
      guest,
      {
        sourceRegister1: 4,
        sourceRegister2: 3,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );
    assert.equal(guest.bytes[20], 0xab);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('sw stores a word', () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 4, signedNumberToBytes(new Uint8Array(8), 20, 32));
    writeGeneralPurposeRegister(
      registers,
      5,
      signedNumberToBytes(new Uint8Array(8), 0x44332211, 32)
    );
    sw(
      registers,
      guest,
      {
        sourceRegister1: 4,
        sourceRegister2: 5,
        immediate: signedNumberToBytes(new Uint8Array(8), 4, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(guest.bytes.subarray(24, 28), Uint8Array.of(0x11, 0x22, 0x33, 0x44));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('sb to an unmapped address below RAM-sized low memory traps with cause 7', () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeGeneralPurposeRegister(registers, 4, signedNumberToBytes(new Uint8Array(8), 0x800, 32));
    writeGeneralPurposeRegister(registers, 3, signedNumberToBytes(new Uint8Array(8), 0xab, 32));

    sb(
      registers,
      guest,
      {
        sourceRegister1: 4,
        sourceRegister2: 3,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_STORE_AMO_ACCESS_FAULT, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      unsignedBigIntToBytes(new Uint8Array(8), 0x800n)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
  });

  it('sd past the end of DRAM traps with cause 7 and leaves memory unchanged', () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    // Aligned, but the last byte falls past the 256-byte RAM window.
    writeGeneralPurposeRegister(registers, 4, signedNumberToBytes(new Uint8Array(8), 0x100, 32));
    writeGeneralPurposeRegister(
      registers,
      5,
      unsignedBigIntToBytes(new Uint8Array(8), 0xdead_beef_cafe_f00dn)
    );

    sd(
      registers,
      guest,
      {
        sourceRegister1: 4,
        sourceRegister2: 5,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_STORE_AMO_ACCESS_FAULT, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      unsignedBigIntToBytes(new Uint8Array(8), 0x100n)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
    // Canary: nothing below the RAM end was written either.
    assert.ok(guest.bytes.subarray(0, 256).every((byte) => byte === 0));
  });

  it('sd to mapped CLINT mtimecmp MMIO stores and advances pc', () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    // mtimecmp sits at CLINT base + 0x4000.
    writeGeneralPurposeRegister(
      registers,
      4,
      signedNumberToBytes(new Uint8Array(8), 0x0200_4000, 32)
    );
    writeGeneralPurposeRegister(registers, 5, signedNumberToBytes(new Uint8Array(8), 0x1234, 32));

    sd(
      registers,
      guest,
      {
        sourceRegister1: 4,
        sourceRegister2: 5,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );

    // No trap: mcause stays at its reset value and the PC advances past the store.
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MCAUSE), new Uint8Array(8));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });
});
