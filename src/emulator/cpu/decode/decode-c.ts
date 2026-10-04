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

/* eslint-disable complexity, sonarjs/cognitive-complexity, max-lines --
   intentional nested switch/case decode; RVC encoding is dense by nature. */

import { signedNumberToBytes } from '#utils/bytes';
import type { Registers } from '#emulator/cpu/types';
import type { Memory } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';
import { lui } from '#emulator/cpu/instructions/lui';
import { jal } from '#emulator/cpu/instructions/jal';
import { jalr } from '#emulator/cpu/instructions/jalr';
import { beq, bne } from '#emulator/cpu/instructions/branch';
import { lw, ld } from '#emulator/cpu/instructions/load';
import { sw, sd } from '#emulator/cpu/instructions/store';
import { addi, andi, slli, srli, srai } from '#emulator/cpu/instructions/op-imm';
import { add, sub, xor, or, and } from '#emulator/cpu/instructions/op';
import { addiw } from '#emulator/cpu/instructions/op-imm-32';
import { addw, subw } from '#emulator/cpu/instructions/op-32';
import { ebreak } from '#emulator/cpu/instructions/system';
import { advanceProgramCounter } from '#emulator/cpu/registers';
import { CAUSE_ILLEGAL_INSTRUCTION, enterTrap, instructionWordTrapValue } from '#emulator/cpu/trap';

type ExecuteThunk = (
  registers: Registers,
  memory: Memory,
  instructionByteLength: ReadonlyUint8Array
) => void | Promise<void>;

const STACK_POINTER = 2;
const RETURN_ADDRESS = 1;
const ZERO_IMMEDIATE = signedNumberToBytes(new Uint8Array(8), 0, 32) as ReadonlyUint8Array;

/** Compact register operand: 3-bit encoding maps to x8–x15. */
const compactRegister = (encoded: number): number => 8 + (encoded & 0x7);

const illegalC =
  (halfword: number): ExecuteThunk =>
  (registers, _memory, _instructionByteLength) => {
    enterTrap(registers, CAUSE_ILLEGAL_INSTRUCTION, instructionWordTrapValue(halfword & 0xffff));
  };

/** HINT / NOP: architecturally no register side effects; advance by instruction length. */
const cNop: ExecuteThunk = (registers, _memory, instructionByteLength) => {
  advanceProgramCounter(registers, instructionByteLength);
};

const function3Of = (halfword: number): number => (halfword >>> 13) & 0x7;
const rdOf = (halfword: number): number => (halfword >>> 7) & 0x1f;
const rs1Of = (halfword: number): number => (halfword >>> 7) & 0x1f;
const rs2Of = (halfword: number): number => (halfword >>> 2) & 0x1f;
const rdPrimeOf = (halfword: number): number => compactRegister((halfword >>> 2) & 0x7);
const rs1PrimeOf = (halfword: number): number => compactRegister((halfword >>> 7) & 0x7);
const rs2PrimeOf = (halfword: number): number => compactRegister((halfword >>> 2) & 0x7);

/** CI-format signed 6-bit immediate: imm[5|4:0] = inst[12|6:2]. */
const decodeCiImm6 = (halfword: number): ReadonlyUint8Array => {
  const imm = ((halfword >>> 7) & 0x20) | ((halfword >>> 2) & 0x1f);
  return signedNumberToBytes(new Uint8Array(8), imm, 6);
};

/**
 * CIW c.addi4spn immediate: imm[5:4|9:6|2|3] = inst[12:11|10:7|6|5], imm[1:0] = 0
 * (already scaled by 4 in the field placement).
 */
const decodeAddi4SpnImmediate = (halfword: number): number =>
  (((halfword >>> 7) & 0xf) << 6) |
  (((halfword >>> 11) & 0x3) << 4) |
  (((halfword >>> 5) & 0x1) << 3) |
  (((halfword >>> 6) & 0x1) << 2);

/** CL/CS c.lw/c.sw offset: uimm[5:3|2|6] = inst[12:10|6|5]. */
const decodeLwSwOffset = (halfword: number): ReadonlyUint8Array => {
  const uimm =
    (((halfword >>> 10) & 0x7) << 3) |
    (((halfword >>> 6) & 0x1) << 2) |
    (((halfword >>> 5) & 0x1) << 6);
  return signedNumberToBytes(new Uint8Array(8), uimm, 32);
};

/** CL/CS c.ld/c.sd offset: uimm[5:3|7:6] = inst[12:10|6:5]. */
const decodeLdSdOffset = (halfword: number): ReadonlyUint8Array => {
  const uimm = (((halfword >>> 10) & 0x7) << 3) | (((halfword >>> 5) & 0x3) << 6);
  return signedNumberToBytes(new Uint8Array(8), uimm, 32);
};

/** CI c.addi16sp: nzimm[9|4|6|8:7|5] = inst[12|6|5|4:3|2]. */
const decodeAddi16SpImmediate = (halfword: number): ReadonlyUint8Array => {
  const nzimm =
    (((halfword >>> 12) & 0x1) << 9) |
    (((halfword >>> 6) & 0x1) << 4) |
    (((halfword >>> 5) & 0x1) << 6) |
    (((halfword >>> 3) & 0x3) << 7) |
    (((halfword >>> 2) & 0x1) << 5);
  return signedNumberToBytes(new Uint8Array(8), nzimm, 10);
};

/** CI c.lui: nzimm[17|16:12] = inst[12|6:2] (sign-extended from bit 17 into the U-imm). */
const decodeLuiImmediate = (halfword: number): ReadonlyUint8Array => {
  const nzimm17_12 = (((halfword >>> 12) & 0x1) << 5) | ((halfword >>> 2) & 0x1f);
  // Place at [17:12]; sign-extend bit 17 through [31:18] for the 32-bit U-immediate.
  const signExtended = (nzimm17_12 << 12) | ((nzimm17_12 & 0x20) !== 0 ? 0xfffc_0000 : 0);
  return signedNumberToBytes(new Uint8Array(8), signExtended, 32);
};

/** CI c.lwsp: offset[5|4:2|7:6] = inst[12|6:4|3:2]. */
const decodeLwSpOffset = (halfword: number): ReadonlyUint8Array => {
  const uimm =
    (((halfword >>> 12) & 0x1) << 5) |
    (((halfword >>> 4) & 0x7) << 2) |
    (((halfword >>> 2) & 0x3) << 6);
  return signedNumberToBytes(new Uint8Array(8), uimm, 32);
};

/** CI c.ldsp: offset[5|4:3|8:6] = inst[12|6:5|4:2]. */
const decodeLdSpOffset = (halfword: number): ReadonlyUint8Array => {
  const uimm =
    (((halfword >>> 12) & 0x1) << 5) |
    (((halfword >>> 5) & 0x3) << 3) |
    (((halfword >>> 2) & 0x7) << 6);
  return signedNumberToBytes(new Uint8Array(8), uimm, 32);
};

/** CSS c.swsp: offset[5:2|7:6] = inst[12:9|8:7]. */
const decodeSwSpOffset = (halfword: number): ReadonlyUint8Array => {
  const uimm = (((halfword >>> 9) & 0xf) << 2) | (((halfword >>> 7) & 0x3) << 6);
  return signedNumberToBytes(new Uint8Array(8), uimm, 32);
};

/** CSS c.sdsp: offset[5:3|8:6] = inst[12:10|9:7]. */
const decodeSdSpOffset = (halfword: number): ReadonlyUint8Array => {
  const uimm = (((halfword >>> 10) & 0x7) << 3) | (((halfword >>> 7) & 0x7) << 6);
  return signedNumberToBytes(new Uint8Array(8), uimm, 32);
};

/** CJ offset: imm[11|4|9:8|10|6|7|3:1|5] = inst[12|11|10:9|8|7|6|5:3|2]. */
const decodeCjOffset = (halfword: number): ReadonlyUint8Array => {
  const imm =
    (((halfword >>> 12) & 0x1) << 11) |
    (((halfword >>> 11) & 0x1) << 4) |
    (((halfword >>> 9) & 0x3) << 8) |
    (((halfword >>> 8) & 0x1) << 10) |
    (((halfword >>> 7) & 0x1) << 6) |
    (((halfword >>> 6) & 0x1) << 7) |
    (((halfword >>> 3) & 0x7) << 1) |
    (((halfword >>> 2) & 0x1) << 5);
  return signedNumberToBytes(new Uint8Array(8), imm, 12);
};

/** CB branch offset: imm[8|4:3|7:6|2:1|5] = inst[12|11:10|6:5|4:3|2]. */
const decodeCbOffset = (halfword: number): ReadonlyUint8Array => {
  const imm =
    (((halfword >>> 12) & 0x1) << 8) |
    (((halfword >>> 10) & 0x3) << 3) |
    (((halfword >>> 5) & 0x3) << 6) |
    (((halfword >>> 3) & 0x3) << 1) |
    (((halfword >>> 2) & 0x1) << 5);
  return signedNumberToBytes(new Uint8Array(8), imm, 9);
};

/** CI/CB shamt: shamt[5|4:0] = inst[12|6:2]. */
const decodeShamt = (halfword: number): number =>
  (((halfword >>> 12) & 0x1) << 5) | ((halfword >>> 2) & 0x1f);

const decodeQuadrant0 = (halfword: number): ExecuteThunk => {
  switch (function3Of(halfword)) {
    case 0b000: {
      // c.addi4spn → addi rd', x2, nzuimm
      const nzuimm = decodeAddi4SpnImmediate(halfword);
      if (nzuimm === 0) {
        return illegalC(halfword);
      }
      const destinationRegister = rdPrimeOf(halfword);
      const immediate = signedNumberToBytes(new Uint8Array(8), nzuimm, 32);
      return (registers, memory, instructionByteLength) =>
        addi(
          registers,
          memory,
          {
            destinationRegister,
            sourceRegister1: STACK_POINTER,
            immediate,
          },
          instructionByteLength
        );
    }
    case 0b010: {
      // c.lw → lw rd', offset(rs1')
      const destinationRegister = rdPrimeOf(halfword);
      const sourceRegister1 = rs1PrimeOf(halfword);
      const immediate = decodeLwSwOffset(halfword);
      return (registers, memory, instructionByteLength) =>
        lw(
          registers,
          memory,
          { destinationRegister, sourceRegister1, immediate },
          instructionByteLength
        );
    }
    case 0b011: {
      // c.ld → ld rd', offset(rs1')
      const destinationRegister = rdPrimeOf(halfword);
      const sourceRegister1 = rs1PrimeOf(halfword);
      const immediate = decodeLdSdOffset(halfword);
      return (registers, memory, instructionByteLength) =>
        ld(
          registers,
          memory,
          { destinationRegister, sourceRegister1, immediate },
          instructionByteLength
        );
    }
    case 0b110: {
      // c.sw → sw rs2', offset(rs1')
      const sourceRegister1 = rs1PrimeOf(halfword);
      const sourceRegister2 = rs2PrimeOf(halfword);
      const immediate = decodeLwSwOffset(halfword);
      return (registers, memory, instructionByteLength) =>
        sw(
          registers,
          memory,
          { sourceRegister1, sourceRegister2, immediate },
          instructionByteLength
        );
    }
    case 0b111: {
      // c.sd → sd rs2', offset(rs1')
      const sourceRegister1 = rs1PrimeOf(halfword);
      const sourceRegister2 = rs2PrimeOf(halfword);
      const immediate = decodeLdSdOffset(halfword);
      return (registers, memory, instructionByteLength) =>
        sd(
          registers,
          memory,
          { sourceRegister1, sourceRegister2, immediate },
          instructionByteLength
        );
    }
    default:
      // c.fld / c.fsd / reserved — not implemented without F/D
      return illegalC(halfword);
  }
};

const decodeQuadrant1Arithmetic = (halfword: number): ExecuteThunk => {
  const rd = rs1PrimeOf(halfword);
  const funct2High = (halfword >>> 10) & 0x3;
  if (funct2High === 0b00) {
    // c.srli → srli rd', rd', shamt (shamt=0 is HINT)
    const shiftAmount = decodeShamt(halfword);
    if (shiftAmount === 0) {
      return cNop;
    }
    return (registers, memory, instructionByteLength) =>
      srli(
        registers,
        memory,
        {
          destinationRegister: rd,
          sourceRegister1: rd,
          shiftAmount,
        },
        instructionByteLength
      );
  }
  if (funct2High === 0b01) {
    // c.srai → srai rd', rd', shamt (shamt=0 is HINT)
    const shiftAmount = decodeShamt(halfword);
    if (shiftAmount === 0) {
      return cNop;
    }
    return (registers, memory, instructionByteLength) =>
      srai(
        registers,
        memory,
        {
          destinationRegister: rd,
          sourceRegister1: rd,
          shiftAmount,
        },
        instructionByteLength
      );
  }
  if (funct2High === 0b10) {
    // c.andi → andi rd', rd', imm
    const immediate = decodeCiImm6(halfword);
    return (registers, memory, instructionByteLength) =>
      andi(
        registers,
        memory,
        {
          destinationRegister: rd,
          sourceRegister1: rd,
          immediate,
        },
        instructionByteLength
      );
  }
  // funct2High === 0b11: CA / wide ops; bit 12 must be 0 for the RV64CA set below,
  // except c.subw/c.addw which also use bit12=1 with funct2 in [6:5].
  const bit12 = (halfword >>> 12) & 0x1;
  const funct2Low = (halfword >>> 5) & 0x3;
  const rs2 = rs2PrimeOf(halfword);
  if (bit12 === 0) {
    switch (funct2Low) {
      case 0b00:
        return (registers, memory, instructionByteLength) =>
          sub(
            registers,
            memory,
            {
              destinationRegister: rd,
              sourceRegister1: rd,
              sourceRegister2: rs2,
            },
            instructionByteLength
          );
      case 0b01:
        return (registers, memory, instructionByteLength) =>
          xor(
            registers,
            memory,
            {
              destinationRegister: rd,
              sourceRegister1: rd,
              sourceRegister2: rs2,
            },
            instructionByteLength
          );
      case 0b10:
        return (registers, memory, instructionByteLength) =>
          or(
            registers,
            memory,
            {
              destinationRegister: rd,
              sourceRegister1: rd,
              sourceRegister2: rs2,
            },
            instructionByteLength
          );
      case 0b11:
        return (registers, memory, instructionByteLength) =>
          and(
            registers,
            memory,
            {
              destinationRegister: rd,
              sourceRegister1: rd,
              sourceRegister2: rs2,
            },
            instructionByteLength
          );
      default:
        return illegalC(halfword);
    }
  }
  // bit12 === 1: c.subw / c.addw (RV64); other funct2 values reserved
  switch (funct2Low) {
    case 0b00:
      return (registers, memory, instructionByteLength) =>
        subw(
          registers,
          memory,
          {
            destinationRegister: rd,
            sourceRegister1: rd,
            sourceRegister2: rs2,
          },
          instructionByteLength
        );
    case 0b01:
      return (registers, memory, instructionByteLength) =>
        addw(
          registers,
          memory,
          {
            destinationRegister: rd,
            sourceRegister1: rd,
            sourceRegister2: rs2,
          },
          instructionByteLength
        );
    default:
      return illegalC(halfword);
  }
};

const decodeQuadrant1 = (halfword: number): ExecuteThunk => {
  switch (function3Of(halfword)) {
    case 0b000: {
      // c.addi / c.nop / HINT
      const rd = rdOf(halfword);
      const immediate = decodeCiImm6(halfword);
      const immIsZero = ((halfword >>> 2) & 0x1f) === 0 && ((halfword >>> 12) & 0x1) === 0;
      if (rd === 0 || immIsZero) {
        // rd=x0 (any imm) or nzimm=0 (any rd): NOP or HINT
        return cNop;
      }
      return (registers, memory, instructionByteLength) =>
        addi(
          registers,
          memory,
          {
            destinationRegister: rd,
            sourceRegister1: rd,
            immediate,
          },
          instructionByteLength
        );
    }
    case 0b001: {
      // c.addiw → addiw rd, rd, imm (rd=x0 illegal)
      const rd = rdOf(halfword);
      if (rd === 0) {
        return illegalC(halfword);
      }
      const immediate = decodeCiImm6(halfword);
      return (registers, memory, instructionByteLength) =>
        addiw(
          registers,
          memory,
          {
            destinationRegister: rd,
            sourceRegister1: rd,
            immediate,
          },
          instructionByteLength
        );
    }
    case 0b010: {
      // c.li → addi rd, x0, imm (rd=x0 is HINT)
      const rd = rdOf(halfword);
      if (rd === 0) {
        return cNop;
      }
      const immediate = decodeCiImm6(halfword);
      return (registers, memory, instructionByteLength) =>
        addi(
          registers,
          memory,
          {
            destinationRegister: rd,
            sourceRegister1: 0,
            immediate,
          },
          instructionByteLength
        );
    }
    case 0b011: {
      const rd = rdOf(halfword);
      const immIsZero = ((halfword >>> 2) & 0x1f) === 0 && ((halfword >>> 12) & 0x1) === 0;
      if (rd === STACK_POINTER) {
        // c.addi16sp → addi x2, x2, nzimm (nzimm=0 reserved)
        if (immIsZero) {
          return illegalC(halfword);
        }
        const immediate = decodeAddi16SpImmediate(halfword);
        return (registers, memory, instructionByteLength) =>
          addi(
            registers,
            memory,
            {
              destinationRegister: STACK_POINTER,
              sourceRegister1: STACK_POINTER,
              immediate,
            },
            instructionByteLength
          );
      }
      // c.lui → lui rd, nzimm (rd=x0 HINT; nzimm=0 reserved)
      if (immIsZero) {
        return illegalC(halfword);
      }
      if (rd === 0) {
        return cNop;
      }
      const immediate = decodeLuiImmediate(halfword);
      return (registers, memory, instructionByteLength) =>
        lui(registers, memory, { destinationRegister: rd, immediate }, instructionByteLength);
    }
    case 0b100:
      return decodeQuadrant1Arithmetic(halfword);
    case 0b101: {
      // c.j → jal x0, offset
      const immediate = decodeCjOffset(halfword);
      return (registers, memory, instructionByteLength) =>
        jal(registers, memory, { destinationRegister: 0, immediate }, instructionByteLength);
    }
    case 0b110: {
      // c.beqz → beq rs1', x0, offset
      const sourceRegister1 = rs1PrimeOf(halfword);
      const immediate = decodeCbOffset(halfword);
      return (registers, memory, instructionByteLength) =>
        beq(
          registers,
          memory,
          {
            sourceRegister1,
            sourceRegister2: 0,
            immediate,
          },
          instructionByteLength
        );
    }
    case 0b111: {
      // c.bnez → bne rs1', x0, offset
      const sourceRegister1 = rs1PrimeOf(halfword);
      const immediate = decodeCbOffset(halfword);
      return (registers, memory, instructionByteLength) =>
        bne(
          registers,
          memory,
          {
            sourceRegister1,
            sourceRegister2: 0,
            immediate,
          },
          instructionByteLength
        );
    }
    default:
      return illegalC(halfword);
  }
};

const decodeQuadrant2 = (halfword: number): ExecuteThunk => {
  switch (function3Of(halfword)) {
    case 0b000: {
      // c.slli → slli rd, rd, shamt (rd=x0 or shamt=0 are HINTs)
      const rd = rdOf(halfword);
      const shiftAmount = decodeShamt(halfword);
      if (rd === 0 || shiftAmount === 0) {
        return cNop;
      }
      return (registers, memory, instructionByteLength) =>
        slli(
          registers,
          memory,
          {
            destinationRegister: rd,
            sourceRegister1: rd,
            shiftAmount,
          },
          instructionByteLength
        );
    }
    case 0b010: {
      // c.lwsp → lw rd, offset(x2) (rd=x0 reserved)
      const rd = rdOf(halfword);
      if (rd === 0) {
        return illegalC(halfword);
      }
      const immediate = decodeLwSpOffset(halfword);
      return (registers, memory, instructionByteLength) =>
        lw(
          registers,
          memory,
          {
            destinationRegister: rd,
            sourceRegister1: STACK_POINTER,
            immediate,
          },
          instructionByteLength
        );
    }
    case 0b011: {
      // c.ldsp → ld rd, offset(x2) (rd=x0 reserved)
      const rd = rdOf(halfword);
      if (rd === 0) {
        return illegalC(halfword);
      }
      const immediate = decodeLdSpOffset(halfword);
      return (registers, memory, instructionByteLength) =>
        ld(
          registers,
          memory,
          {
            destinationRegister: rd,
            sourceRegister1: STACK_POINTER,
            immediate,
          },
          instructionByteLength
        );
    }
    case 0b100: {
      const bit12 = (halfword >>> 12) & 0x1;
      const rs1 = rs1Of(halfword);
      const rs2 = rs2Of(halfword);
      if (bit12 === 0) {
        if (rs2 === 0) {
          // c.jr → jalr x0, rs1, 0 (rs1=x0 reserved)
          if (rs1 === 0) {
            return illegalC(halfword);
          }
          return (registers, memory, instructionByteLength) =>
            jalr(
              registers,
              memory,
              {
                destinationRegister: 0,
                sourceRegister1: rs1,
                immediate: ZERO_IMMEDIATE,
              },
              instructionByteLength
            );
        }
        // c.mv → add rd, x0, rs2 (rd=x0 is HINT)
        if (rs1 === 0) {
          return cNop;
        }
        return (registers, memory, instructionByteLength) =>
          add(
            registers,
            memory,
            {
              destinationRegister: rs1,
              sourceRegister1: 0,
              sourceRegister2: rs2,
            },
            instructionByteLength
          );
      }
      if (rs2 === 0) {
        if (rs1 === 0) {
          // c.ebreak
          return (registers, memory, instructionByteLength) =>
            ebreak(registers, memory, instructionByteLength);
        }
        // c.jalr → jalr x1, rs1, 0
        return (registers, memory, instructionByteLength) =>
          jalr(
            registers,
            memory,
            {
              destinationRegister: RETURN_ADDRESS,
              sourceRegister1: rs1,
              immediate: ZERO_IMMEDIATE,
            },
            instructionByteLength
          );
      }
      // c.add → add rd, rd, rs2 (rd=x0 is HINT)
      if (rs1 === 0) {
        return cNop;
      }
      return (registers, memory, instructionByteLength) =>
        add(
          registers,
          memory,
          {
            destinationRegister: rs1,
            sourceRegister1: rs1,
            sourceRegister2: rs2,
          },
          instructionByteLength
        );
    }
    case 0b110: {
      // c.swsp → sw rs2, offset(x2)
      const sourceRegister2 = rs2Of(halfword);
      const immediate = decodeSwSpOffset(halfword);
      return (registers, memory, instructionByteLength) =>
        sw(
          registers,
          memory,
          {
            sourceRegister1: STACK_POINTER,
            sourceRegister2,
            immediate,
          },
          instructionByteLength
        );
    }
    case 0b111: {
      // c.sdsp → sd rs2, offset(x2)
      const sourceRegister2 = rs2Of(halfword);
      const immediate = decodeSdSpOffset(halfword);
      return (registers, memory, instructionByteLength) =>
        sd(
          registers,
          memory,
          {
            sourceRegister1: STACK_POINTER,
            sourceRegister2,
            immediate,
          },
          instructionByteLength
        );
    }
    default:
      // c.fldsp / c.fsdsp — not implemented without F/D
      return illegalC(halfword);
  }
};

/**
 * Decode one RV64C halfword into an execute thunk.
 * Caller passes `TWO_BYTES` when invoking the thunk.
 */
const decodeC = (halfword: number): ExecuteThunk => {
  const encoding = halfword & 0xffff;
  if (encoding === 0) {
    return illegalC(encoding);
  }
  switch (encoding & 0x3) {
    case 0b00:
      return decodeQuadrant0(encoding);
    case 0b01:
      return decodeQuadrant1(encoding);
    case 0b10:
      return decodeQuadrant2(encoding);
    default:
      return illegalC(encoding);
  }
};

export default decodeC;
