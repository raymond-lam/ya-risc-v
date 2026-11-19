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
import { loadBytes } from '#emulator/memory';
import {
  createRegisters,
  readGeneralPurposeRegister,
  readProgramCounter,
  setPrivilegeMode,
  PRIVILEGE_SUPERVISOR,
  setProgramCounter,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
  FOUR_BYTES,
  MEPC,
  MCAUSE,
  MTVAL,
  MTVEC,
  SATP,
} from '#emulator/cpu/registers';
import { CAUSE_STORE_AMO_ACCESS_FAULT } from '#emulator/cpu/trap';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';
import { storeBytes } from '#emulator/memory';

const allowAllPmp = (registers: ReturnType<typeof createRegisters>): void => {
  writeControlAndStatusRegister(
    registers,
    0x3b0,
    unsignedBigIntToBytes(new Uint8Array(8), 0x3fffffffffffffn)
  );
  writeControlAndStatusRegister(registers, 0x3a0, unsignedBigIntToBytes(new Uint8Array(8), 0x1fn));
};

describe('store', () => {
  it('sb stores the low byte', async () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 3, signedNumberToBytes(new Uint8Array(8), 0xab, 32));
    writeGeneralPurposeRegister(registers, 4, signedNumberToBytes(new Uint8Array(8), 20, 32));
    await sb(
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

  it('sw stores a word', async () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 4, signedNumberToBytes(new Uint8Array(8), 20, 32));
    writeGeneralPurposeRegister(
      registers,
      5,
      signedNumberToBytes(new Uint8Array(8), 0x44332211, 32)
    );
    await sw(
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

  it('sb to an unmapped address below RAM-sized low memory traps with cause 7', async () => {
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

    await sb(
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

  it('sd past the end of DRAM traps with cause 7 and leaves memory unchanged', async () => {
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

    await sd(
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

  it('sd to mapped CLINT mtimecmp MMIO stores and advances pc', async () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    // mtimecmp sits at CLINT base + 0x4000.
    writeGeneralPurposeRegister(
      registers,
      4,
      signedNumberToBytes(new Uint8Array(8), 0x0200_4000, 32)
    );
    writeGeneralPurposeRegister(registers, 5, signedNumberToBytes(new Uint8Array(8), 0x1234, 32));

    await sd(
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

    // The stored value actually landed in mtimecmp (x5 = 0x1234, little-endian).
    const mtimecmp = new Uint8Array(8);
    await loadBytes({
      destination: mtimecmp,
      memory: guest,
      address: signedNumberToBytes(new Uint8Array(8), 0x0200_4000, 32),
      byteLength: 8,
    });
    assert.deepEqual(mtimecmp, Uint8Array.of(0x34, 0x12, 0, 0, 0, 0, 0, 0));
  });
});

describe('translated store access (Sv39)', () => {
  it('sd through Sv39 translation writes memory and advances PC', async () => {
    // Build Sv39 page table: root@PA0, L1@PA0x1000, L0@PA0x2000.
    // VA 0x8000 → PA 0x10000.
    // L2 idx=0, L1 idx=0, L0 idx=(0x8000>>12)&0x1ff=8.
    // Leaf at L0 base 0x2000 + 8*8 = 0x2040.
    const guest = testMemory(0x30000n);
    // Root at PA 0: V=1,A=1,PPN=1→PTE=(1<<10)|1|64=1089=0x441.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0n),
      source: unsignedBigIntToBytes(new Uint8Array(8), (1n << 10n) | 1n | 64n),
      byteLength: 8,
    });
    // L1 at PA 0x1000: V=1,A=1,PPN=2→PTE=(2<<10)|1|64=2113=0x841.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x1000n),
      source: unsignedBigIntToBytes(new Uint8Array(8), (2n << 10n) | 1n | 64n),
      byteLength: 8,
    });
    // L0 at PA 0x2000+8*8=0x2040: leaf for PA 0x10000. V=1,R=1,W=1,A=1,D=1,PPN=0x10.
    // byte0 = V(1)|R(1)|W(1)|A(1)|D(1) = 0b11000111 = 0xc7.
    // PTE=(0x10<<10)|0xc7=0x40c7.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x2040n),
      source: unsignedBigIntToBytes(new Uint8Array(8), (0x10n << 10n) | 0xc7n),
      byteLength: 8,
    });
    // Target page at PA 0x10000.

    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    allowAllPmp(registers);
    // Root at PA 0 → satp PPN = 0 → just MODE=8.
    writeControlAndStatusRegister(
      registers,
      SATP,
      unsignedBigIntToBytes(new Uint8Array(8), 8n << 60n)
    );
    writeGeneralPurposeRegister(registers, 4, signedNumberToBytes(new Uint8Array(8), 0x8000, 32));
    writeGeneralPurposeRegister(registers, 5, signedNumberToBytes(new Uint8Array(8), 0x55, 32));

    await sd(
      registers,
      guest,
      {
        sourceRegister1: 4,
        sourceRegister2: 5,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );

    // Debug: check MCAUSE to see if there was a trap
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      new Uint8Array(8),
      'expected no trap'
    );
    // Check that 0x55 was written to PA 0x10000 (VA 0x8000 → PA 0x10000, offset 0).
    assert.equal(guest.bytes[0x10000], 0x55);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('store page fault (cause 15) with V=0 leaf traps and does not advance PC', async () => {
    // Page tables in RAM but leaf is V=0 (invalid) → page fault.
    // VA 0x8000: L2 idx=0, L1 idx=0, L0 idx=8.
    // Leaf at 0x2000+8*8=0x2040.
    const guest = testMemory(0x30000n);
    // Root at PA 0: V=1,A=1,PPN=1→PTE=(1<<10)|1|64=1089.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0n),
      source: unsignedBigIntToBytes(new Uint8Array(8), (1n << 10n) | 1n | 64n),
      byteLength: 8,
    });
    // L1 at PA 0x1000: V=1,A=1,PPN=2→PTE=(2<<10)|1|64=2113.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x1000n),
      source: unsignedBigIntToBytes(new Uint8Array(8), (2n << 10n) | 1n | 64n),
      byteLength: 8,
    });
    // L0 at PA 0x2040: V=0 (invalid)→page fault. PTE=(0x10<<10)=0x4000.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x2040n),
      source: unsignedBigIntToBytes(new Uint8Array(8), 0x10n << 10n),
      byteLength: 8,
    });

    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    allowAllPmp(registers);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      SATP,
      unsignedBigIntToBytes(new Uint8Array(8), 8n << 60n)
    );
    writeGeneralPurposeRegister(registers, 4, signedNumberToBytes(new Uint8Array(8), 0x8000, 32));
    writeGeneralPurposeRegister(registers, 5, signedNumberToBytes(new Uint8Array(8), 0x42, 32));

    await sd(
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
      signedNumberToBytes(new Uint8Array(8), 15, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      unsignedBigIntToBytes(new Uint8Array(8), 0x8000n)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
  });

  it('sw through Sv39 translation with R=0 W=1 leaf traps with cause 15', async () => {
    // VA 0x8000: L2 idx=0, L1 idx=0, L0 idx=8.
    // Leaf at 0x2000+8*8=0x2040.
    const guest = testMemory(0x30000n);
    // Root at PA 0: V=1,A=1,PPN=1→PTE=(1<<10)|1|64=1089.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0n),
      source: unsignedBigIntToBytes(new Uint8Array(8), (1n << 10n) | 1n | 64n),
      byteLength: 8,
    });
    // L1 at PA 0x1000: V=1,A=1,PPN=2→PTE=(2<<10)|1|64=2113.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x1000n),
      source: unsignedBigIntToBytes(new Uint8Array(8), (2n << 10n) | 1n | 64n),
      byteLength: 8,
    });
    // L0 at PA 0x2040: V=1,A=1,PPN=0x10,no W→permission fault. PTE=(0x10<<10)|0x41=0x4041.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x2040n),
      source: unsignedBigIntToBytes(new Uint8Array(8), (0x10n << 10n) | 0x41n),
      byteLength: 8,
    });

    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    allowAllPmp(registers);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      SATP,
      unsignedBigIntToBytes(new Uint8Array(8), 8n << 60n)
    );
    writeGeneralPurposeRegister(registers, 4, signedNumberToBytes(new Uint8Array(8), 0x8000, 32));
    writeGeneralPurposeRegister(registers, 5, signedNumberToBytes(new Uint8Array(8), 0x99, 32));

    await sw(
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
      signedNumberToBytes(new Uint8Array(8), 15, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      unsignedBigIntToBytes(new Uint8Array(8), 0x8000n)
    );
  });
});
