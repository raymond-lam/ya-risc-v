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
import decode from '#emulator/cpu/decode';
import { loadBytes, storeBytes, type Memory } from '#emulator/memory';
import testMemory from '#test/guest-memory';
import {
  createRegisters,
  snapshotControlAndStatusRegister,
  readGeneralPurposeRegister,
  readProgramCounter,
  setProgramCounter,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#emulator/cpu/registers';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

/** mstatus low fields with hardwired UXL/SXL=64 (byte4 = 0x0a). */
const mstatusBytes = (low32: number): Uint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), BigInt(low32 >>> 0) | (0xan << 32n));
import type { ReadonlyUint8Array } from '#types';

const runDecoded = (
  word: Uint8Array,
  registers: ReturnType<typeof createRegisters>,
  memory: ReturnType<typeof testMemory>
) => {
  const [execute, instructionByteLength] = decode(word);
  return execute(registers, memory, instructionByteLength);
};

/** Pack a 32-bit instruction encoding as little-endian bytes. */
const instructionBytes = (encoding: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  bytes[0] = encoding & 0xff;
  bytes[1] = (encoding >>> 8) & 0xff;
  bytes[2] = (encoding >>> 16) & 0xff;
  bytes[3] = (encoding >>> 24) & 0xff;
  return bytes;
};

const CLINT_MTIMECMP = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_4000n) as ReadonlyUint8Array;
const CLINT_MTIME = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_bff8n) as ReadonlyUint8Array;

/** Assert CLINT timer wire and `mie.MTIE` so `wfi` returns without waiting. */
const armTimerWake = (registers: ReturnType<typeof createRegisters>, memory: Memory): void => {
  storeBytes({
    memory,
    address: CLINT_MTIMECMP,
    source: unsignedBigIntToBytes(new Uint8Array(8), 0n),
    byteLength: 8,
  });
  storeBytes({
    memory,
    address: CLINT_MTIME,
    source: unsignedBigIntToBytes(new Uint8Array(8), 0n),
    byteLength: 8,
  });
  writeControlAndStatusRegister(registers, 0x304, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
};

describe('decode + execute', () => {
  it('executes addi x1, x0, 42 and advances pc', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    // addi x1, x0, 42
    runDecoded(instructionBytes(0x02a00093), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 42, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('executes csrrw x1, 0x300, x2 and advances pc', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x22, 32));
    writeControlAndStatusRegister(
      registers,
      0x300,
      signedNumberToBytes(new Uint8Array(8), 0x11, 32)
    );
    // csrrw x1, 0x300, x2
    runDecoded(instructionBytes(0x300110f3), registers, memory);
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), mstatusBytes(0x11));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, 0x300), mstatusBytes(0x22));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('executes csrrwi x1, 0x300, 31 as a zero-extended immediate', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    // csrrwi x1, 0x300, 31
    runDecoded(instructionBytes(0x300fd0f3), registers, memory);
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), mstatusBytes(0));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, 0x300), mstatusBytes(31));
  });

  it('executes lui x1, 0x12345', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    // lui x1, 0x12345
    runDecoded(instructionBytes(0x123450b7), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0x12345000, 32)
    );
  });

  it('executes mul x3, x1, x2 and advances pc', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 6, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 7, 32));
    // mul x3, x1, x2
    runDecoded(instructionBytes(0x022081b3), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 42, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('executes mulw x3, x1, x2 and advances pc', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 6, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 7, 32));
    // mulw x3, x1, x2
    runDecoded(instructionBytes(0x022081bb), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 42, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('executes sw then lw round-trip', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(
      registers,
      1,
      signedNumberToBytes(new Uint8Array(8), 0xaabbccdd, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 16, 32));

    // sw x1, 0(x2)
    runDecoded(instructionBytes(0x00112023), registers, memory);
    const stored = new Uint8Array(4);
    loadBytes({
      destination: stored,
      memory,
      address: signedNumberToBytes(new Uint8Array(8), 16, 32),
      byteLength: 4,
    });
    assert.deepEqual(stored, new Uint8Array([0xdd, 0xcc, 0xbb, 0xaa]));

    // lw x3, 0(x2)
    runDecoded(instructionBytes(0x00012183), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 0xaabbccdd, 32)
    );
  });

  it('executes mret after seeding mepc', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeControlAndStatusRegister(
      registers,
      0x341,
      signedNumberToBytes(new Uint8Array(8), 0x20, 32)
    );
    // mret
    runDecoded(instructionBytes(0x30200073), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x20);
  });

  it('executes sret after seeding sepc', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeControlAndStatusRegister(
      registers,
      0x141,
      signedNumberToBytes(new Uint8Array(8), 0x30, 32)
    );
    // sret (legal in M-mode)
    runDecoded(instructionBytes(0x10200073), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x30);
  });

  it('executes wfi and resumes once an interrupt is pending and enabled in mie', async () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    armTimerWake(registers, memory);
    await runDecoded(instructionBytes(0x10500073), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x44);
  });

  it('executes amoadd.w and advances pc', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    memory.bytes[8] = 5;
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 8, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 7, 32));
    // amoadd.w x3, x2, (x1)
    runDecoded(instructionBytes(0x0020_a1af), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 5, 32)
    );
    assert.equal(memory.bytes[8], 12);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('traps on an illegal encoding and records mtval', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeControlAndStatusRegister(
      registers,
      0x305,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    // all-ones is not a valid 32-bit encoding
    runDecoded(instructionBytes(0xffff_ffff), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x341),
      signedNumberToBytes(new Uint8Array(8), 0x40, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x342),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, 0x343)), 0xffff_ffff);
  });

  it('executes a compressed encoding from a 32-bit fetch (low halfword)', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    // Low halfword 0x0001 is c.nop; high halfword is ignored for length/decode.
    runDecoded(instructionBytes(0xdead_0001), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 2);
  });

  it('traps lr.w with rs2 !== x0 as illegal', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeControlAndStatusRegister(
      registers,
      0x305,
      signedNumberToBytes(new Uint8Array(8), 0x3000, 32)
    );
    // lr.w x1, (x2) but with rs2 = x3: funct5=LR, aq/rl=0, rs2=3, rs1=2, funct3=W, rd=1, opcode=AMO
    // encoding: 00010 00 00011 00010 010 00001 0101111 = 0x103120af
    runDecoded(instructionBytes(0x1031_20af), registers, memory);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x342),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x3000);
  });

  it('traps ecall/ebreak with non-zero rd or rs1 as illegal', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeControlAndStatusRegister(
      registers,
      0x305,
      signedNumberToBytes(new Uint8Array(8), 0x4000, 32)
    );
    // ecall with rd = x1: 000000000000 00000 000 00001 1110011 = 0x000000f3
    runDecoded(instructionBytes(0x0000_00f3), registers, memory);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x342),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x4000);

    writeControlAndStatusRegister(
      registers,
      0x305,
      signedNumberToBytes(new Uint8Array(8), 0x5000, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0, 32));
    // ebreak with rs1 = x1: 000000000001 00001 000 00000 1110011 = 0x00108073
    runDecoded(instructionBytes(0x0010_8073), registers, memory);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x342),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x5000);
  });

  it('beq/bne and jal decode scattered negative offsets (imm[12], imm[11], imm[20] bits)', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);

    // beq x0, x0, -8: imm[12]=imm[11]=1, imm[10:5]=111111, imm[4:1]=1100.
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    runDecoded(instructionBytes(0xfe00_0ce3), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x38);

    // beq x0, x0, +2048: only imm[11] is set — a dropped bit 7 lands at +0 instead.
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    runDecoded(instructionBytes(0x0000_00e3), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x840);

    // jal x1, -16: imm[20]=imm[11]=1 and imm[10:1] carries the low tail; the link register gets PC + 4.
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    runDecoded(instructionBytes(0xff1f_f0ef), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x30);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0x44, 32)
    );

    // addi x1, x0, -1: the I-type sign bit at imm[11] must sign-extend.
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    runDecoded(instructionBytes(0xfff0_0093), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), -1, 32)
    );
  });

  it('reserved shift encodings trap as illegal (funct6, slliw bit 25)', () => {
    const illegal = (encoding: number): void => {
      const registers = createRegisters();
      const memory = testMemory(64n);
      writeControlAndStatusRegister(
        registers,
        0x305,
        signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
      );
      runDecoded(instructionBytes(encoding), registers, memory);
      assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000, encoding.toString(16));
      assert.deepEqual(
        snapshotControlAndStatusRegister(registers, 0x342),
        signedNumberToBytes(new Uint8Array(8), 2, 32)
      );
      assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, 0x343)), encoding);
    };

    // slli with funct6 = 000001 (must be 000000 on RV64).
    illegal(0x0411_1093);
    // srai with funct6 = 000001 (must be 010000).
    illegal(0x0411_5093);
    // slliw with shamt bit 5 set (w-form shifts are 5-bit only).
    illegal(0x0211_109b);
  });
});
