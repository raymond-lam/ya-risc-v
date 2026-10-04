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
import testMemory from '#test/guest-memory';
import {
  createRegisters,
  readGeneralPurposeRegister,
  readProgramCounter,
  setProgramCounter,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#emulator/cpu/registers';
import { bytesToNumber, signedNumberToBytes } from '#utils/bytes';

const runDecoded = (
  word: Uint8Array,
  registers: ReturnType<typeof createRegisters>,
  memory: ReturnType<typeof testMemory>
) => {
  const [execute, instructionByteLength] = decode(word);
  return execute(registers, memory, instructionByteLength);
};

/** Pack a 16-bit RVC encoding into the low half of a 4-byte fetch buffer. */
const compressedBytes = (halfword: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  bytes[0] = halfword & 0xff;
  bytes[1] = (halfword >>> 8) & 0xff;
  return bytes;
};

/** Build a CI/CL/… halfword from the common RVC field layout. */
const rvc = (fields: {
  funct3: number;
  bit12?: number;
  rd?: number;
  rs1?: number;
  rs2?: number;
  imm5?: number;
  quadrant: number;
}): number => {
  const bit12 = fields.bit12 ?? 0;
  const mid = fields.rd ?? fields.rs1 ?? 0;
  const low = fields.rs2 ?? fields.imm5 ?? 0;
  return (
    ((fields.funct3 & 0x7) << 13) |
    ((bit12 & 0x1) << 12) |
    ((mid & 0x1f) << 7) |
    ((low & 0x1f) << 2) |
    (fields.quadrant & 0x3)
  );
};

describe('RV64C decode + execute', () => {
  it('c.nop advances pc by 2', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x100, 32));
    runDecoded(compressedBytes(0x0001), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x102);
  });

  it('c.li writes rd and advances pc by 2', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    // c.li x1, 1 → 0x4085
    runDecoded(compressedBytes(0x4085), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 2);
  });

  it('c.addi adds an immediate into rd', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 10, 32));
    // c.addi x1, 5 → funct3=000, rd=1, imm=5, q=01 → 0x0095
    runDecoded(compressedBytes(0x0095), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 15, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 2);
  });

  it('c.mv copies rs2 into rd', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 99, 32));
    // c.mv x1, x2 → 0x808a
    runDecoded(compressedBytes(0x808a), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 99, 32)
    );
  });

  it('c.add adds rs2 into rd', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 3, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 4, 32));
    // c.add x1, x2 → bit12=1, rs1=1, rs2=2, funct3=100, q=10 → 0x908a
    runDecoded(compressedBytes(0x908a), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 7, 32)
    );
  });

  it('c.lw / c.sw round-trip through compact registers', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    // x8 base = 0x40; store x9 (=0x12345678) at 0(x8) via c.sw, then c.lw into x10
    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeGeneralPurposeRegister(
      registers,
      9,
      signedNumberToBytes(new Uint8Array(8), 0x12345678, 32)
    );
    // c.sw rs2'=x9 (1), rs1'=x8 (0), offset=0
    runDecoded(compressedBytes(0xc004), registers, memory);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0, 32));
    // c.lw rd'=x10 (2), rs1'=x8 (0), offset=0
    runDecoded(compressedBytes(0x4008), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 10),
      signedNumberToBytes(new Uint8Array(8), 0x12345678, 32)
    );
  });

  it('c.ld / c.sd round-trip a doubleword', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeGeneralPurposeRegister(registers, 9, signedNumberToBytes(new Uint8Array(8), -1, 32));
    // c.sd rs2'=x9, rs1'=x8, offset=0 → funct3=111, q=00 → 0xe004
    runDecoded(compressedBytes(0xe004), registers, memory);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0, 32));
    // c.ld rd'=x10, rs1'=x8, offset=0 → funct3=011 → 0x6008
    runDecoded(compressedBytes(0x6008), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 10),
      signedNumberToBytes(new Uint8Array(8), -1, 32)
    );
  });

  it('c.lwsp / c.swsp use x2 as base', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x20, 32));
    writeGeneralPurposeRegister(registers, 5, signedNumberToBytes(new Uint8Array(8), 0x55, 32));
    // c.swsp x5, 0
    runDecoded(compressedBytes(0xc016), registers, memory);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0, 32));
    // c.lwsp x6, 0
    runDecoded(compressedBytes(0x4302), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 6),
      signedNumberToBytes(new Uint8Array(8), 0x55, 32)
    );
  });

  it('c.j jumps with a PC-relative offset', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x100, 32));
    // c.j +8 → offset=8: imm[3:1]=100 → bits[5:3]=100, rest 0
    // funct3=101, q=01: 101 0 0 0 0 0 100 0 01 → bits[5:3]=100 means bit5=0,bit4=0,bit3=1?
    // imm[3:1] = inst[5:3], for offset 8 = 0b1000 → imm[3:1]=100, imm[5]=0,...
    // inst[5:3]=100 = 4<<3 = 0x20? bits 5:3 = 100 binary = 4, so (4<<3)=0x20 in halfword
    // 0xa000 | 0x20 | 0x1 = 0xa021
    runDecoded(compressedBytes(0xa021), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x108);
  });

  it('c.jr jumps to rs1 without linking', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 5, signedNumberToBytes(new Uint8Array(8), 0x200, 32));
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    // c.jr x5
    runDecoded(compressedBytes(0x8282), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x200);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
  });

  it('c.jalr links pc+2 into x1', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 5, signedNumberToBytes(new Uint8Array(8), 0x200, 32));
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    // c.jalr x5
    runDecoded(compressedBytes(0x9282), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x200);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0x42, 32)
    );
  });

  it('c.beqz / c.bnez take and fall through', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), 0, 32));
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x100, 32));
    // c.beqz x8, +8 (offset bit3 → inst[11:10]=01) → 0xc401
    runDecoded(compressedBytes(0xc401), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x108);

    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), 1, 32));
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x100, 32));
    runDecoded(compressedBytes(0xc401), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x102);

    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x100, 32));
    // c.bnez x8, +8 → 0xe401
    runDecoded(compressedBytes(0xe401), registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x108);
  });

  it('c.sub / c.and / c.or / c.xor on compact registers', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), 0xf0, 32));
    writeGeneralPurposeRegister(registers, 9, signedNumberToBytes(new Uint8Array(8), 0x0f, 32));
    // c.and x8, x9 → funct3=100, funct2High=11, bit12=0, funct2Low=11, rd'=0, rs2'=1
    // 100 0 11 000 11 001 01 = 0x8c65
    runDecoded(compressedBytes(0x8c65), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 8),
      signedNumberToBytes(new Uint8Array(8), 0x00, 32)
    );

    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), 0xf0, 32));
    // c.or x8, x9 → funct2Low=10 → 0x8c45
    runDecoded(compressedBytes(0x8c45), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 8),
      signedNumberToBytes(new Uint8Array(8), 0xff, 32)
    );

    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), 0xf0, 32));
    // c.xor x8, x9 → funct2Low=01 → 0x8c25
    runDecoded(compressedBytes(0x8c25), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 8),
      signedNumberToBytes(new Uint8Array(8), 0xff, 32)
    );

    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), 10, 32));
    writeGeneralPurposeRegister(registers, 9, signedNumberToBytes(new Uint8Array(8), 3, 32));
    // c.sub x8, x9 → funct2Low=00 → 0x8c05
    runDecoded(compressedBytes(0x8c05), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 8),
      signedNumberToBytes(new Uint8Array(8), 7, 32)
    );
  });

  it('c.addiw / c.addw / c.subw operate on 32-bit values', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(
      registers,
      1,
      signedNumberToBytes(new Uint8Array(8), 0x7fffffff, 32)
    );
    // c.addiw x1, 1 → funct3=001, rd=1, imm=1, q=01 → 0x2085
    runDecoded(compressedBytes(0x2085), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), -0x80000000, 32)
    );

    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), 5, 32));
    writeGeneralPurposeRegister(registers, 9, signedNumberToBytes(new Uint8Array(8), 3, 32));
    // c.addw x8, x9 → bit12=1, funct2Low=01 → 0x9c25
    runDecoded(compressedBytes(0x9c25), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 8),
      signedNumberToBytes(new Uint8Array(8), 8, 32)
    );

    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), 5, 32));
    // c.subw x8, x9 → funct2Low=00 → 0x9c05
    runDecoded(compressedBytes(0x9c05), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 8),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
  });

  it('c.slli / c.srli / c.srai shift compact and full registers', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 1, 32));
    // c.slli x1, 3 → funct3=000, rd=1, shamt=3, q=10 → 0x00ce?
    // 000 0 00001 00011 10 = 0x008e
    runDecoded(compressedBytes(0x008e), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 8, 32)
    );

    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    // c.srli x8, 4 → funct2High=00, shamt=4 → 0x8011?
    // 100 0 00 000 00100 01 = 0x8011
    runDecoded(compressedBytes(0x8011), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 8),
      signedNumberToBytes(new Uint8Array(8), 0x08, 32)
    );

    writeGeneralPurposeRegister(registers, 8, signedNumberToBytes(new Uint8Array(8), -32, 32));
    // c.srai x8, 2 → funct2High=01 → 0x8409
    // 100 0 01 000 00010 01 = 0x8409
    runDecoded(compressedBytes(0x8409), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 8),
      signedNumberToBytes(new Uint8Array(8), -8, 32)
    );
  });

  it('c.addi4spn / c.addi16sp adjust the stack pointer', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x1000, 32));
    // c.addi4spn x8, 16 → nzuimm=16: imm[9:6|5:4|3|2]=0001_00_0_0 → inst[10:7]=0001
    // funct3=000, rd'=0, q=00: 000 00 0001 000 00 00 → bits[10:7]=0001 → 0x0020?
    // imm=16 = 0b10000 → imm[4]=1 → inst[12:11]=01?
    // imm layout: [9:6]=inst[10:7], [5:4]=inst[12:11], [3]=inst[5], [2]=inst[6]
    // For 16 = bit 4 set: inst[12:11]=01, rest 0 → 000 01 0000 000 000 00 = 0x0800
    runDecoded(compressedBytes(0x0800), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 8),
      signedNumberToBytes(new Uint8Array(8), 0x1010, 32)
    );

    // c.addi16sp 32 → nzimm=32: imm[5]=1 → inst[2]=1
    // funct3=011, rd=x2, q=01: 011 0 00010 00001 01 = 0x6145
    runDecoded(compressedBytes(0x6145), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 0x1030, 32)
    );
  });

  it('c.lui loads an upper immediate', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    // c.lui x1, 1 → nzimm=1 at [16:12]: inst[6:2]=00001, bit12=0
    // funct3=011, rd=1, q=01: 011 0 00001 00001 01 = 0x6085
    runDecoded(compressedBytes(0x6085), registers, memory);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
  });

  it('c.ebreak traps like ebreak', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeControlAndStatusRegister(
      registers,
      0x305,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x100, 32));
    runDecoded(compressedBytes(0x9002), registers, memory);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x342),
      signedNumberToBytes(new Uint8Array(8), 3, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
  });

  it('all-zero halfword and reserved encodings trap as illegal', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeControlAndStatusRegister(
      registers,
      0x305,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x100, 32));
    runDecoded(compressedBytes(0x0000), registers, memory);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x342),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, 0x343)), 0);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);

    const registers2 = createRegisters();
    writeControlAndStatusRegister(
      registers2,
      0x305,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    // c.fld-looking encoding (quadrant 0, funct3=001) without F → illegal
    runDecoded(
      compressedBytes(rvc({ funct3: 0b001, rd: 0, imm5: 0, quadrant: 0b00 })),
      registers2,
      memory
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers2, 0x342),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
  });

  it('c.addi4spn with zero immediate is illegal', () => {
    const registers = createRegisters();
    const memory = testMemory(64n);
    writeControlAndStatusRegister(
      registers,
      0x305,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    runDecoded(compressedBytes(0x0004), registers, memory);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x342),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
  });
});
