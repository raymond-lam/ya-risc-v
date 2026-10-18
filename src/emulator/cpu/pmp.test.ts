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
import { lb, ld, lw } from '#emulator/cpu/instructions/load';
import { csrrw } from '#emulator/cpu/instructions/system';
import { sb } from '#emulator/cpu/instructions/store';
import {
  createRegisters,
  FOUR_BYTES,
  MCAUSE,
  MSTATUS,
  MTVAL,
  MTVEC,
  PRIVILEGE_MACHINE,
  PRIVILEGE_SUPERVISOR,
  readGeneralPurposeRegister,
  readPrivilegeMode,
  readProgramCounter,
  setPrivilegeMode,
  setProgramCounter,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#emulator/cpu/registers';
import testMemory from '#test/guest-memory';
import {
  bytesToBigInt,
  bytesToNumber,
  signedNumberToBytes,
  unsignedBigIntToBytes,
} from '#utils/bytes';

const PMPCFG0 = 0x3a0;
const PMPCFG1 = 0x3a1;
const PMPADDR0 = 0x3b0;
const PMPADDR1 = 0x3b1;

/** R + NAPOT. */
const CFG_NAPOT_R = 0x19;
/** R + W + NAPOT + lock. */
const CFG_NAPOT_RW_LOCK = 0x9b;
/** R + X + NAPOT + lock (no write). */
const CFG_NAPOT_RX_LOCK = 0x9d;
/** TOR + lock. */
const CFG_TOR_LOCK = 0x88;
/** W + NAPOT, which must drop W because R is clear. */
const CFG_NAPOT_W = 0x1a;
/** NA4 + R. */
const CFG_NA4_R = 0x11;
/** NA4, no permissions. */
const CFG_NA4 = 0x10;
/** TOR + R. pmpaddr is the top of the range; entry 0 starts at 0. */
const CFG_TOR_R = 0x09;

const guestBytes = (value: bigint): Uint8Array => unsignedBigIntToBytes(new Uint8Array(8), value);

const writePmp = (
  registers: ReturnType<typeof createRegisters>,
  index: number,
  value: bigint
): void => {
  writeControlAndStatusRegister(registers, index, guestBytes(value));
};

describe('pmp', () => {
  it('drops W without R and keeps a locked config byte', () => {
    const registers = createRegisters();
    writePmp(registers, PMPCFG0, BigInt(CFG_NAPOT_W));
    assert.equal(snapshotControlAndStatusRegister(registers, PMPCFG0)[0], 0x18);

    writePmp(registers, PMPCFG0, BigInt(CFG_NAPOT_RW_LOCK));
    writePmp(registers, PMPCFG0, 0n);
    assert.equal(snapshotControlAndStatusRegister(registers, PMPCFG0)[0], CFG_NAPOT_RW_LOCK);
  });

  it('stores only address bits 55:2 in pmpaddr', () => {
    const registers = createRegisters();
    writePmp(registers, PMPADDR0, (1n << 64n) - 1n);
    assert.equal(
      bytesToBigInt(snapshotControlAndStatusRegister(registers, PMPADDR0)),
      (1n << 54n) - 1n
    );
  });

  it('ignores a pmpaddr write while the entry is locked', () => {
    const registers = createRegisters();
    writePmp(registers, PMPADDR0, 4n);
    writePmp(registers, PMPCFG0, BigInt(CFG_NAPOT_RW_LOCK));
    writePmp(registers, PMPADDR0, 9n);
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, PMPADDR0)), 4);
  });

  it('a locked TOR entry freezes the previous pmpaddr', () => {
    const registers = createRegisters();
    writePmp(registers, PMPADDR0, 5n);
    writePmp(registers, PMPADDR1, 8n);
    const cfg = new Uint8Array(8);
    cfg[1] = CFG_TOR_LOCK;
    writeControlAndStatusRegister(registers, PMPCFG0, cfg);
    writePmp(registers, PMPADDR0, 9n);
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, PMPADDR0)), 5);
  });

  it('treats odd pmpcfg as an illegal CSR', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x20, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x100, 32)
    );
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        controlAndStatusRegister: PMPCFG1,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x100);
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, MCAUSE)), 2);
  });

  it('allows an S-mode load inside a NAPOT region and denies one outside it', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    guest.bytes[0x10] = 0x2a;
    writePmp(registers, PMPADDR0, 0x10n >> 2n);
    writePmp(registers, PMPCFG0, BigInt(CFG_NAPOT_R));
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x10, 32));

    lb(
      registers,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readGeneralPurposeRegister(registers, 1)), 0x2a);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);

    setProgramCounter(registers, new Uint8Array(8));
    writeGeneralPurposeRegister(registers, 1, new Uint8Array(8));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x20, 32));
    lb(
      registers,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readGeneralPurposeRegister(registers, 1)), 0);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x80);
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, MCAUSE)), 5);
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)), 0x20);
  });

  it('denies an S-mode load that spans past the matching region', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    writePmp(registers, PMPADDR0, 0n);
    writePmp(registers, PMPCFG0, BigInt(CFG_NAPOT_R));
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 6, 32));
    lw(
      registers,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x80);
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, MCAUSE)), 5);
  });

  it('allows an S-mode load below a TOR top and denies one at the top', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    guest.bytes[0x1f] = 0x3;
    writePmp(registers, PMPADDR0, 0x20n >> 2n);
    writePmp(registers, PMPCFG0, BigInt(CFG_TOR_R));
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x1f, 32));
    lb(
      registers,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readGeneralPurposeRegister(registers, 1)), 0x3);

    setProgramCounter(registers, new Uint8Array(8));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x20, 32));
    lb(
      registers,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x80);
  });

  it('faults when the first matching entry covers only part of the access', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    guest.bytes[0x10] = 0xab;
    // Entry 0 is NA4 at 0x10. Entry 1 is NAPOT [0, 32) with R, which would allow the
    // whole 8-byte load if the partial entry were skipped.
    writePmp(registers, PMPADDR0, 0x10n >> 2n);
    writePmp(registers, PMPADDR1, 0b11n);
    writePmp(registers, PMPCFG0, BigInt(CFG_NA4_R | (CFG_NAPOT_R << 8)));
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x10, 32));
    ld(
      registers,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readGeneralPurposeRegister(registers, 1)), 0);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x80);
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, MCAUSE)), 5);

    const machine = createRegisters();
    writePmp(machine, PMPADDR0, 0x10n >> 2n);
    writePmp(machine, PMPCFG0, BigInt(CFG_NA4));
    writeControlAndStatusRegister(machine, MTVEC, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeGeneralPurposeRegister(machine, 2, signedNumberToBytes(new Uint8Array(8), 0x10, 32));
    lw(
      machine,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readGeneralPurposeRegister(machine, 1)), 0xab);
    setProgramCounter(machine, new Uint8Array(8));
    ld(
      machine,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readProgramCounter(machine)), 0x80);
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(machine, MCAUSE)), 5);
  });

  it('lets M-mode through an unlocked deny and stops it on a locked entry', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    guest.bytes[0x10] = 0x11;
    writePmp(registers, PMPADDR0, 0x10n >> 2n);
    writePmp(registers, PMPCFG0, BigInt(0x18));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x10, 32));
    lb(
      registers,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readGeneralPurposeRegister(registers, 1)), 0x11);
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_MACHINE);

    writePmp(registers, PMPCFG0, BigInt(CFG_NAPOT_RX_LOCK));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    setProgramCounter(registers, new Uint8Array(8));
    sb(
      registers,
      guest,
      { sourceRegister1: 2, sourceRegister2: 3, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(guest.bytes[0x10], 0x11);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x80);
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, MCAUSE)), 7);
  });

  it('applies MPP when mstatus.MPRV is set', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    const mstatus = new Uint8Array(8);
    mstatus[1] = 0x08;
    mstatus[2] = 0x02;
    writeControlAndStatusRegister(registers, MSTATUS, mstatus);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 4, 32));
    lb(
      registers,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x80);
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, MCAUSE)), 5);
  });

  it('allows an NA4 read and denies the next byte', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    guest.bytes[0x10] = 0x7;
    guest.bytes[0x14] = 0x8;
    writePmp(registers, PMPADDR0, 0x10n >> 2n);
    writePmp(registers, PMPCFG0, BigInt(CFG_NA4_R));
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x10, 32));
    lb(
      registers,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readGeneralPurposeRegister(registers, 1)), 0x7);

    setProgramCounter(registers, new Uint8Array(8));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x14, 32));
    lb(
      registers,
      guest,
      { destinationRegister: 1, sourceRegister1: 2, immediate: new Uint8Array(8) },
      FOUR_BYTES
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x80);
  });
});
