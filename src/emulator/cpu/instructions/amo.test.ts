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
import {
  amoaddD,
  amoaddW,
  amominW,
  amominuW,
  amoswapD,
  lrD,
  lrW,
  scD,
  scW,
} from '#emulator/cpu/instructions/amo';
import { sw } from '#emulator/cpu/instructions/store';
import {
  createRegisters,
  readGeneralPurposeRegister,
  readProgramCounter,
  setProgramCounter,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#emulator/cpu/registers';
import { CAUSE_STORE_AMO_ADDRESS_MISALIGNED } from '#emulator/cpu/trap';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

describe('amo', () => {
  it('lr.d / sc.d succeed and advance pc', () => {
    const guest = testMemory(256n);
    guest.bytes[16] = 0x11;
    guest.bytes[17] = 0x22;
    guest.bytes[18] = 0x33;
    guest.bytes[19] = 0x44;
    guest.bytes[20] = 0x55;
    guest.bytes[21] = 0x66;
    guest.bytes[22] = 0x77;
    guest.bytes[23] = 0x88;
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 16, 32));
    writeGeneralPurposeRegister(
      registers,
      2,
      unsignedBigIntToBytes(new Uint8Array(8), 0x99aa_bbcc_ddeeff00n)
    );

    lrD(registers, guest, {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 0,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      unsignedBigIntToBytes(new Uint8Array(8), 0x8877_6655_4433_2211n)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);

    scD(registers, guest, {
      destinationRegister: 4,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 4),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.deepEqual(
      guest.bytes.slice(16, 24),
      Uint8Array.of(0x00, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 8);
  });

  it('sc.w fails after an overlapping store clears the reservation', () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 32, 32));
    writeGeneralPurposeRegister(
      registers,
      2,
      signedNumberToBytes(new Uint8Array(8), 0x11111111, 32)
    );
    writeGeneralPurposeRegister(
      registers,
      5,
      signedNumberToBytes(new Uint8Array(8), 0x22222222, 32)
    );

    lrW(registers, guest, {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 0,
    });
    sw(registers, guest, {
      sourceRegister1: 1,
      sourceRegister2: 5,
      immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
    });
    scW(registers, guest, {
      destinationRegister: 4,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 4),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.deepEqual(guest.bytes.slice(32, 36), Uint8Array.of(0x22, 0x22, 0x22, 0x22));
  });

  it('sc.w fails after a same-line neighbor store', () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 32, 32));
    writeGeneralPurposeRegister(registers, 6, signedNumberToBytes(new Uint8Array(8), 60, 32));
    writeGeneralPurposeRegister(
      registers,
      2,
      signedNumberToBytes(new Uint8Array(8), 0x11111111, 32)
    );
    writeGeneralPurposeRegister(
      registers,
      5,
      signedNumberToBytes(new Uint8Array(8), 0x33333333, 32)
    );

    lrW(registers, guest, {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 0,
    });
    sw(registers, guest, {
      sourceRegister1: 6,
      sourceRegister2: 5,
      immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
    });
    scW(registers, guest, {
      destinationRegister: 4,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 4),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.deepEqual(guest.bytes.slice(32, 36), new Uint8Array(4));
  });

  it('amoadd.w returns the old value and stores the sum', () => {
    const guest = testMemory(256n);
    guest.bytes[8] = 0xfe;
    guest.bytes[9] = 0xff;
    guest.bytes[10] = 0xff;
    guest.bytes[11] = 0xff;
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 8, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 3, 32));

    amoaddW(registers, guest, {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), -2, 32)
    );
    assert.deepEqual(guest.bytes.slice(8, 12), Uint8Array.of(0x01, 0x00, 0x00, 0x00));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('amoswap.d exchanges memory and rd', () => {
    const guest = testMemory(256n);
    for (let index = 0; index < 8; index += 1) {
      guest.bytes[40 + index] = index + 1;
    }
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 40, 32));
    writeGeneralPurposeRegister(
      registers,
      2,
      unsignedBigIntToBytes(new Uint8Array(8), 0x0102_0304_0506_0708n)
    );

    amoswapD(registers, guest, {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      unsignedBigIntToBytes(new Uint8Array(8), 0x0807_0605_0403_0201n)
    );
    assert.deepEqual(
      guest.bytes.slice(40, 48),
      Uint8Array.of(0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01)
    );
  });

  it('amomin.w and amominu.w differ on high bit', () => {
    const guest = testMemory(256n);
    guest.bytes[48] = 0xff;
    guest.bytes[49] = 0xff;
    guest.bytes[50] = 0xff;
    guest.bytes[51] = 0x7f;
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 48, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), -1, 32));

    amominW(registers, guest, {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 0x7fffffff, 32)
    );
    assert.deepEqual(guest.bytes.slice(48, 52), Uint8Array.of(0xff, 0xff, 0xff, 0xff));

    guest.bytes[48] = 0xff;
    guest.bytes[49] = 0xff;
    guest.bytes[50] = 0xff;
    guest.bytes[51] = 0x7f;
    amominuW(registers, guest, {
      destinationRegister: 4,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(guest.bytes.slice(48, 52), Uint8Array.of(0xff, 0xff, 0xff, 0x7f));
  });

  it('amoadd.d wraps at 64 bits and advances pc', () => {
    const guest = testMemory(256n);
    for (let index = 0; index < 8; index += 1) {
      guest.bytes[64 + index] = 0xff;
    }
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 64, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 1, 32));

    amoaddD(registers, guest, {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      unsignedBigIntToBytes(new Uint8Array(8), 0xffff_ffff_ffff_ffffn)
    );
    assert.deepEqual(guest.bytes.slice(64, 72), new Uint8Array(8));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('misaligned lr.w traps with cause 6 and does not arm a reservation', () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      0x305,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 2, 32));

    lrW(registers, guest, {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 0,
    });

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x342),
      signedNumberToBytes(new Uint8Array(8), CAUSE_STORE_AMO_ADDRESS_MISALIGNED, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x343),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);

    // A subsequent aligned sc must fail — no reservation was armed.
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0, 32));
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 16, 32));
    writeGeneralPurposeRegister(
      registers,
      2,
      signedNumberToBytes(new Uint8Array(8), 0x11111111, 32)
    );
    scW(registers, guest, {
      destinationRegister: 4,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 4),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.deepEqual(guest.bytes.slice(16, 20), new Uint8Array(4));
  });

  it('misaligned amoadd.w traps with cause 6 and leaves memory unchanged', () => {
    const guest = testMemory(256n);
    guest.bytes[2] = 0xaa;
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      0x305,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 2, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 1, 32));

    amoaddW(registers, guest, {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x342),
      signedNumberToBytes(new Uint8Array(8), CAUSE_STORE_AMO_ADDRESS_MISALIGNED, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x343),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
    assert.equal(guest.bytes[2], 0xaa);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
  });

  it('misaligned sc.d traps with cause 6', () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      0x305,
      signedNumberToBytes(new Uint8Array(8), 0x3000, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 4, 32));

    scD(registers, guest, {
      destinationRegister: 3,
      sourceRegister1: 1,
      sourceRegister2: 2,
    });

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x342),
      signedNumberToBytes(new Uint8Array(8), CAUSE_STORE_AMO_ADDRESS_MISALIGNED, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x3000);
  });
});
