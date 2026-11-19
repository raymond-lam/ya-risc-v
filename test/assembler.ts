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

// RISC-V instruction encoders and a tiny two-pass assembler for integration images.

export const OP_LUI = 0b0110111n;
export const OP_IMM = 0b0010011n;
export const OP_STORE = 0b0100011n;
export const OP_LOAD = 0b0000011n;
export const OP_BRANCH = 0b1100011n;
export const OP_OP = 0b0110011n;
export const OP_SYS = 0b1110011n;
export const OP_JALR = 0b1100111n;

export const F3_ADD = 0b000n;
export const F3_ANDI = 0b111n;
export const F3_SLLI = 0b001n;
export const F3_SRLI = 0b101n;
export const F3_LB = 0b000n;
export const F3_LD = 0b011n;
export const F3_SB = 0b000n;
export const F3_SW = 0b010n;
export const F3_SD = 0b011n;
export const F3_BEQ = 0b000n;
export const F3_BNE = 0b001n;
export const F3_OR = 0b110n;
export const F3_CSRRW = 0b001n;
export const F3_CSRRS = 0b010n;

export const CSR_MTVEC = 0x305;
export const CSR_MEPC = 0x341;
export const CSR_SEPC = 0x141;
export const CSR_MSTATUS = 0x300;
export const CSR_MCAUSE = 0x342;
export const CSR_MEDELEG = 0x302;
export const CSR_PMPCFG0 = 0x3a0;
export const CSR_PMPADDR0 = 0x3b0;
export const CSR_SATP = 0x180;
export const CSR_STVEC = 0x105;
export const CSR_SCAUSE = 0x142;
export const CSR_STVAL = 0x143;
export const CSR_MENVCFG = 0x30a;

export const wU = (rd: number, imm20: bigint, op: bigint): number =>
  Number((((imm20 & 0xfffffn) << 12n) | (BigInt(rd) << 7n) | op) & 0xffffffffn);

export const wI = (rd: number, rs1: number, imm12: bigint, f3: bigint, op: bigint): number => {
  const s = ((imm12 & 0xfffn) << 20n) >> 20n;
  return Number(
    ((s & 0xfffn) << 20n) | (BigInt(rs1) << 15n) | (f3 << 12n) | (BigInt(rd) << 7n) | op
  );
};

export const wS = (f3: bigint, rs1: number, rs2: number, imm12: bigint): number => {
  const m = imm12 & 0xfffn;
  return Number(
    ((m >> 5n) << 25n) |
      (BigInt(rs2) << 20n) |
      (BigInt(rs1) << 15n) |
      (f3 << 12n) |
      ((m & 0x1fn) << 7n) |
      OP_STORE
  );
};

export const wB = (f3: bigint, rs1: number, rs2: number, off: bigint): number => {
  const m = off & 0x1fffn;
  return Number(
    (((m >> 12n) & 1n) << 31n) |
      (((m >> 5n) & 0x3fn) << 25n) |
      (BigInt(rs2) << 20n) |
      (BigInt(rs1) << 15n) |
      (f3 << 12n) |
      (((m >> 1n) & 0xfn) << 8n) |
      (((m >> 11n) & 1n) << 7n) |
      OP_BRANCH
  );
};

export const wR = (f3: bigint, rd: number, rs1: number, rs2: number, f7: bigint): number =>
  Number(
    (f7 << 25n) |
      (BigInt(rs2) << 20n) |
      (BigInt(rs1) << 15n) |
      (f3 << 12n) |
      (BigInt(rd) << 7n) |
      OP_OP
  );

export const wCsr = (rd: number, csr: number, rs1: number, f3: bigint): number =>
  Number((BigInt(csr) << 20n) | (BigInt(rs1) << 15n) | (f3 << 12n) | (BigInt(rd) << 7n) | OP_SYS);

export const wIShift = (rd: number, rs1: number, shamt: bigint, f3: bigint, op: bigint): number =>
  Number((BigInt(shamt) << 20n) | (BigInt(rs1) << 15n) | (f3 << 12n) | (BigInt(rd) << 7n) | op);

export const lui = (rd: number, imm: bigint): number => wU(rd, imm, OP_LUI);
export const addi = (rd: number, rs1: number, imm: bigint): number =>
  wI(rd, rs1, imm, F3_ADD, OP_IMM);
export const andi = (rd: number, rs1: number, imm: bigint): number =>
  wI(rd, rs1, imm, F3_ANDI, OP_IMM);
export const slli = (rd: number, rs1: number, shamt: bigint): number =>
  wIShift(rd, rs1, shamt & 0x3fn, F3_SLLI, OP_IMM);
export const srli = (rd: number, rs1: number, shamt: bigint): number =>
  wIShift(rd, rs1, shamt & 0x3fn, F3_SRLI, OP_IMM);
export const lb = (rd: number, rs1: number, imm: bigint): number =>
  wI(rd, rs1, imm, F3_LB, OP_LOAD);
export const ld = (rd: number, rs1: number, imm: bigint): number =>
  wI(rd, rs1, imm, F3_LD, OP_LOAD);
export const sb = (rs1: number, rs2: number, imm: bigint): number => wS(F3_SB, rs1, rs2, imm);
export const sw = (rs1: number, rs2: number, imm: bigint): number => wS(F3_SW, rs1, rs2, imm);
export const sd = (rs1: number, rs2: number, imm: bigint): number => wS(F3_SD, rs1, rs2, imm);
export const beq = (rs1: number, rs2: number, off: bigint): number => wB(F3_BEQ, rs1, rs2, off);
export const bne = (rs1: number, rs2: number, off: bigint): number => wB(F3_BNE, rs1, rs2, off);
export const add = (rd: number, rs1: number, rs2: number): number => wR(F3_ADD, rd, rs1, rs2, 0n);
export const or_ = (rd: number, rs1: number, rs2: number): number => wR(F3_OR, rd, rs1, rs2, 0n);
export const csrrw = (rd: number, csr: number, rs1: number): number => wCsr(rd, csr, rs1, F3_CSRRW);
export const csrrs = (rd: number, csr: number, rs1: number): number => wCsr(rd, csr, rs1, F3_CSRRS);
export const sret = (): number => wCsr(0, 0x102, 0, 0n);
export const mret = (): number => wCsr(0, 0x302, 0, 0n);
export const jalr = (rd: number, rs1: number, imm: bigint): number =>
  wI(rd, rs1, imm, F3_ADD, OP_JALR);

export type Instruction = {
  emit: (labels: Map<string, number>, myOff: number) => number;
  comment: string;
};

export class Assembler {
  private instrs: Instruction[] = [];
  private labels = new Map<string, number>();
  private off = 0;

  defineLabel = (name: string): void => {
    this.labels.set(name, this.off);
  };

  emit = (i: Instruction): void => {
    this.instrs.push(i);
    this.off += 4;
  };

  assemble = (): Uint8Array => {
    const bytes = new Uint8Array(this.instrs.length * 4);
    for (let i = 0; i < this.instrs.length; i++) {
      const myOff = i * 4;
      const word = this.instrs[i]!.emit(this.labels, myOff);
      bytes[myOff] = word & 0xff;
      bytes[myOff + 1] = (word >> 8) & 0xff;
      bytes[myOff + 2] = (word >> 16) & 0xff;
      bytes[myOff + 3] = (word >> 24) & 0xff;
    }
    return bytes;
  };

  /** Expose resolved labels for diagnostics (read-only snapshot). */
  resolvedLabels = (): ReadonlyMap<string, number> => new Map(this.labels);
}

export const writePte = (buf: Uint8Array, offset: number, val: bigint): void => {
  for (let b = 0; b < 8; b++) {
    buf[offset + b] = Number((val >> BigInt(b * 8)) & 0xffn);
  }
};

export const leafPte = (ppn: bigint, flags: bigint): bigint => (ppn << 10n) | flags;
export const ptrPte = (ppn: bigint): bigint => (ppn << 10n) | 1n;
