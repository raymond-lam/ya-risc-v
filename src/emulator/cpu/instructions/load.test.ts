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
import { lb, lh, lbu, ld, lw, lhu, lwu } from '#emulator/cpu/instructions/load';
import {
  createRegisters,
  readGeneralPurposeRegister,
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
  SATP,
} from '#emulator/cpu/registers';
import { CAUSE_LOAD_ACCESS_FAULT } from '#emulator/cpu/trap';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';
import { storeBytes } from '#emulator/memory';

describe('load', () => {
  it('lb sign-extends and lbu zero-extends', async () => {
    const guest = testMemory(256n);
    guest.bytes[10] = 0x80;
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 10, 32));

    await lb(
      registers,
      guest,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), -128, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);

    await lbu(
      registers,
      guest,
      {
        destinationRegister: 3,
        sourceRegister1: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 8);
  });

  it('lw loads a word', async () => {
    const guest = testMemory(256n);
    guest.bytes[8] = 0x78;
    guest.bytes[9] = 0x56;
    guest.bytes[10] = 0x34;
    guest.bytes[11] = 0x12;
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 8, 32));

    await lw(
      registers,
      guest,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0x12345678, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('lb from an unmapped address below RAM-sized low memory traps with cause 5', async () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    // 256-byte RAM covers [0, 0x100); 0x800 is an unmapped hole below the
    // syscon window at 0x10_0000.
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x800, 32));

    await lb(
      registers,
      guest,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_LOAD_ACCESS_FAULT, 32)
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
    // The trap aborted the load: rd keeps its reset value.
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), new Uint8Array(8));
  });

  it('ld past the end of DRAM traps with cause 5 and does not advance pc', async () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    // Aligned, but the last byte falls past the 256-byte RAM window.
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x100, 32));

    await ld(
      registers,
      guest,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_LOAD_ACCESS_FAULT, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      unsignedBigIntToBytes(new Uint8Array(8), 0x100n)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), new Uint8Array(8));
  });

  it('lb does not wrap a 2^32+offset address into low memory', async () => {
    const guest = testMemory(256n);
    guest.bytes[16] = 0x42;
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    writeGeneralPurposeRegister(registers, 2, new Uint8Array([0x10, 0, 0, 0, 1, 0, 0, 0]));

    await lb(
      registers,
      guest,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );
    // The unmapped high address faults instead of wrapping into low memory.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_LOAD_ACCESS_FAULT, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      unsignedBigIntToBytes(new Uint8Array(8), 0x1_0000_0010n)
    );
    // The trap aborts the load, so rd keeps its reset value too.
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), new Uint8Array(8));
    assert.equal(guest.bytes[16], 0x42);
  });

  it('ld from mapped CLINT mtimecmp MMIO loads the reset value and advances pc', async () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    // mtimecmp sits at CLINT base + 0x4000; initializeClint resets it to all-ones.
    writeGeneralPurposeRegister(
      registers,
      2,
      signedNumberToBytes(new Uint8Array(8), 0x0200_4000, 32)
    );

    await ld(
      registers,
      guest,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );

    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      unsignedBigIntToBytes(new Uint8Array(8), 0xffff_ffff_ffff_ffffn)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('lwu zero-extends while lw sign-extends the same word; lh/lhu pin halfword width', async () => {
    const guest = testMemory(256n);
    // 0xffff_ffff at offset 8; 0x8000 at offset 16.
    guest.bytes[8] = 0xff;
    guest.bytes[9] = 0xff;
    guest.bytes[10] = 0xff;
    guest.bytes[11] = 0xff;
    guest.bytes[16] = 0x00;
    guest.bytes[17] = 0x80;
    const registers = createRegisters();

    await lw(
      registers,
      guest,
      {
        destinationRegister: 1,
        sourceRegister1: 0,
        immediate: signedNumberToBytes(new Uint8Array(8), 8, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      unsignedBigIntToBytes(new Uint8Array(8), 0xffff_ffff_ffff_ffffn)
    );

    await lwu(
      registers,
      guest,
      {
        destinationRegister: 2,
        sourceRegister1: 0,
        immediate: signedNumberToBytes(new Uint8Array(8), 8, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      unsignedBigIntToBytes(new Uint8Array(8), 0x0000_0000_ffff_ffffn)
    );

    await lh(
      registers,
      guest,
      {
        destinationRegister: 3,
        sourceRegister1: 0,
        immediate: signedNumberToBytes(new Uint8Array(8), 16, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      unsignedBigIntToBytes(new Uint8Array(8), 0xffff_ffff_ffff_8000n)
    );

    await lhu(
      registers,
      guest,
      {
        destinationRegister: 4,
        sourceRegister1: 0,
        immediate: signedNumberToBytes(new Uint8Array(8), 16, 32),
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 4),
      unsignedBigIntToBytes(new Uint8Array(8), 0x0000_0000_0000_8000n)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 16);
  });
});

describe('translated load access (Sv39)', () => {
  it('lb through Sv39 translation writes rd and advances PC', async () => {
    // Build Sv39 page table: root@PA0, L1@PA0x1000, L0@PA0x2000.
    // VA 0x8000 → PA 0x10000.
    // L2 idx=0, L1 idx=0, L0 idx=(0x8000>>12)&0x1ff=8.
    // Leaf at L0 base 0x2000 + 8*8 = 0x2040.
    const guest = testMemory(0x30000n);
    // Root at PA 0: V=1,A=1, points to L1 at PA 0x1000 (PPN=1).
    // PTE = PTE_V | PTE_A | (PPN<<10) = 1 | 64 | 1024 = 1089 = 0x441.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0n),
      source: unsignedBigIntToBytes(new Uint8Array(8), (1n << 10n) | 1n | 64n),
      byteLength: 8,
    });
    // L1 at PA 0x1000: V=1,A=1, points to L0 at PA 0x2000 (PPN=2).
    // PTE = 1 | 64 | 2048 = 2113 = 0x841.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x1000n),
      source: unsignedBigIntToBytes(new Uint8Array(8), (2n << 10n) | 1n | 64n),
      byteLength: 8,
    });
    // L0 at PA 0x2000+8*8=0x2040: leaf for PA 0x10000. V=1,R=1,A=1,PPN=0x10.
    // flags = V(1)|R(1)|A(1) = 0x47 (R=1 is required for isLeafPte to return true).
    // PTE = (PPN<<10) | 0x47 = 0x4047.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x2040n),
      source: unsignedBigIntToBytes(new Uint8Array(8), (0x10n << 10n) | 0x47n),
      byteLength: 8,
    });
    // Target page at PA 0x10000 contains 0xab.
    guest.bytes[0x10000] = 0xab;

    const registers = createRegisters();
    // Root at PA 0 → satp PPN=0, MODE=8 (Sv39).
    writeControlAndStatusRegister(
      registers,
      SATP,
      unsignedBigIntToBytes(new Uint8Array(8), 8n << 60n)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x8000, 32));

    await lb(
      registers,
      guest,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );

    // 0xab sign-extended from 8 bits = -85.
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), -85, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('ld through Sv39 translation on V=0 leaf traps with cause 13 and leaves rd unchanged', async () => {
    // Page tables in RAM but leaf is V=0 → page fault.
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
    // L0 at PA 0x2040: V=0 (invalid)→page fault→PTE=(0x10<<10)=0x4000.
    await storeBytes({
      memory: guest,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x2040n),
      source: unsignedBigIntToBytes(new Uint8Array(8), 0x10n << 10n),
      byteLength: 8,
    });

    const registers = createRegisters();
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
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x8000, 32));
    writeGeneralPurposeRegister(
      registers,
      1,
      signedNumberToBytes(new Uint8Array(8), 0xdeadbeef, 32)
    );

    await ld(
      registers,
      guest,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), 13, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      unsignedBigIntToBytes(new Uint8Array(8), 0x8000n)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    // PC = trap vector
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
    // rd unchanged
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0xdeadbeef, 32)
    );
  });

  it('lw through Sv39 translation with V=0 at root level traps with cause 13', async () => {
    const guest = testMemory(256n);
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));

    // Root PTE with V=0: page table doesn't exist.
    guest.bytes[0x1000] = 0x00;
    writeControlAndStatusRegister(
      registers,
      SATP,
      unsignedBigIntToBytes(new Uint8Array(8), (8n << 60n) | 1n)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0xface, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x8000, 32));

    await lw(
      registers,
      guest,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
      },
      FOUR_BYTES
    );

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), 13, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      unsignedBigIntToBytes(new Uint8Array(8), 0x8000n)
    );
    // rd unchanged
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0xface, 32)
    );
  });
});
