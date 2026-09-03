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
   intentional nested switch/case decode; RISC-V encoding is dense by nature. */

import { bytesToNumber, signedNumberToBytes } from '#utils/bytes.js';
import type { Registers } from '#cpu/types.js';
import { lui } from '#cpu/instructions/lui.js';
import { auipc } from '#cpu/instructions/auipc.js';
import { jal } from '#cpu/instructions/jal.js';
import { jalr } from '#cpu/instructions/jalr.js';
import { beq, bne, blt, bge, bltu, bgeu } from '#cpu/instructions/branch.js';
import { lb, lh, lw, ld, lbu, lhu, lwu } from '#cpu/instructions/load.js';
import { sb, sh, sw, sd } from '#cpu/instructions/store.js';
import { addi, slti, sltiu, xori, ori, andi, slli, srli, srai } from '#cpu/instructions/op-imm.js';
import { add, sub, sll, slt, sltu, xor, srl, sra, or, and } from '#cpu/instructions/op.js';
import { addiw, slliw, srliw, sraiw } from '#cpu/instructions/op-imm-32.js';
import { addw, subw, sllw, srlw, sraw } from '#cpu/instructions/op-32.js';
import fence from '#cpu/instructions/misc-mem.js';
import {
  ecall,
  ebreak,
  mret,
  csrrw,
  csrrs,
  csrrc,
  csrrwi,
  csrrsi,
  csrrci,
} from '#cpu/instructions/system.js';
import { CAUSE_ILLEGAL_INSTRUCTION, enterTrap, instructionWordTrapValue } from '#cpu/trap.js';

const OPCODE_LOAD = 0x03; // loads: lb/lh/lw/ld/lbu/lhu/lwu
const OPCODE_MISC_MEM = 0x0f; // fence (memory ordering)
const OPCODE_OP_IMM = 0x13; // integer ops with immediate: addi/slti/…/andi/slli/srli/srai
const OPCODE_AUIPC = 0x17; // add upper immediate to pc
const OPCODE_OP_IMM_32 = 0x1b; // 32-bit integer ops with immediate (RV64): addiw/slliw/srliw/sraiw
const OPCODE_STORE = 0x23; // stores: sb/sh/sw/sd
const OPCODE_OP = 0x33; // register–register integer ops: add/sub/sll/…/and
const OPCODE_LUI = 0x37; // load upper immediate
const OPCODE_OP_32 = 0x3b; // 32-bit register–register ops (RV64): addw/subw/sllw/srlw/sraw
const OPCODE_BRANCH = 0x63; // conditional branches: beq/bne/blt/bge/bltu/bgeu
const OPCODE_JALR = 0x67; // jump and link register
const OPCODE_JAL = 0x6f; // jump and link
const OPCODE_SYSTEM = 0x73; // system: ecall/ebreak/mret/csrrw/csrrs/csrrc/csrrwi/csrrsi/csrrci

const FUNCT3_ADD_SUB = 0x0; // addition (OP also uses funct7 for subtraction)
const FUNCT3_SLL = 0x1; // shift left logical
const FUNCT3_SLT = 0x2; // set rd to 1 if signed less-than
const FUNCT3_SLTU = 0x3; // set rd to 1 if unsigned less-than
const FUNCT3_XOR = 0x4; // bitwise exclusive or
const FUNCT3_SRL_SRA = 0x5; // shift right; funct7 selects logical vs arithmetic
const FUNCT3_OR = 0x6; // bitwise or
const FUNCT3_AND = 0x7; // bitwise and

const FUNCT3_BEQ = 0x0; // branch if equal
const FUNCT3_BNE = 0x1; // branch if not equal
const FUNCT3_BLT = 0x4; // branch if less than (signed)
const FUNCT3_BGE = 0x5; // branch if greater or equal (signed)
const FUNCT3_BLTU = 0x6; // branch if less than (unsigned)
const FUNCT3_BGEU = 0x7; // branch if greater or equal (unsigned)

const FUNCT3_LB = 0x0; // load byte (sign-extended)
const FUNCT3_LH = 0x1; // load halfword (sign-extended)
const FUNCT3_LW = 0x2; // load word (sign-extended)
const FUNCT3_LD = 0x3; // load doubleword
const FUNCT3_LBU = 0x4; // load byte (zero-extended)
const FUNCT3_LHU = 0x5; // load halfword (zero-extended)
const FUNCT3_LWU = 0x6; // load word (zero-extended)

const FUNCT3_SB = 0x0; // store byte
const FUNCT3_SH = 0x1; // store halfword
const FUNCT3_SW = 0x2; // store word
const FUNCT3_SD = 0x3; // store doubleword

const FUNCT3_FENCE = 0x0; // fence under MISC-MEM
const FUNCT3_SYSTEM = 0x0; // ecall/ebreak/mret under SYSTEM (distinguished by imm)
const FUNCT3_CSRRW = 0x1; // atomic CSR read/write
const FUNCT3_CSRRS = 0x2; // atomic CSR read and set
const FUNCT3_CSRRC = 0x3; // atomic CSR read and clear
const FUNCT3_CSRRWI = 0x5; // atomic CSR read/write immediate
const FUNCT3_CSRRSI = 0x6; // atomic CSR read and set immediate
const FUNCT3_CSRRCI = 0x7; // atomic CSR read and clear immediate

/** funct12 for mret (imm[11:0] when funct3 = SYSTEM). */
const FUNCT12_MRET = 0x302;

const FUNCT7_NORMAL = 0x00; // default funct7: add/sll/srl/…
const FUNCT7_SUB_SRA = 0x20; // alternate funct7: sub/sra (and sraw/sraiw)

/** Illegal encoding: synchronous trap with cause 2; mtval holds the instruction word. */
const illegalInstruction = (registers: Registers, instructionWord: number): void => {
  enterTrap(registers, CAUSE_ILLEGAL_INSTRUCTION, instructionWordTrapValue(instructionWord));
};

/**
 * I-type immediate (addi, andi, loads, jalr, …).
 *
 * Layout in the instruction word:
 *   imm[11:0] = instruction[31:20]
 *
 * Returns that signed 12-bit value as a 64-bit little-endian byte array.
 */
const decodeITypeImmediate = (instructionWord: number): Uint8Array => {
  const imm11_0 = instructionWord >>> 20;
  return signedNumberToBytes(new Uint8Array(8), imm11_0, 12);
};

/**
 * S-type immediate (stores: sb/sh/sw/sd).
 *
 * The immediate is split around rs2 in the encoding:
 *   imm[11:5] = instruction[31:25]
 *   imm[4:0]  = instruction[11:7]
 *
 * Returns that signed 12-bit value as a 64-bit little-endian byte array.
 */
const decodeSTypeImmediate = (instructionWord: number): Uint8Array => {
  const imm11_5 = (instructionWord >>> 25) & 0x7f;
  const imm4_0 = (instructionWord >>> 7) & 0x1f;
  const imm11_0 = (imm11_5 << 5) | imm4_0;
  return signedNumberToBytes(new Uint8Array(8), imm11_0, 12);
};

/**
 * B-type immediate (branches: beq/bne/blt/…).
 *
 * Branch offsets are multiples of 2; bit 0 of the immediate is always 0.
 * Scattered fields:
 *   imm[12]   = instruction[31]
 *   imm[11]   = instruction[7]
 *   imm[10:5] = instruction[30:25]
 *   imm[4:1]  = instruction[11:8]
 *   imm[0]    = 0
 *
 * Returns that signed 13-bit value as a 64-bit little-endian byte array.
 */
const decodeBTypeImmediate = (instructionWord: number): Uint8Array => {
  const imm12 = (instructionWord >>> 31) & 0x1;
  const imm11 = (instructionWord >>> 7) & 0x1;
  const imm10_5 = (instructionWord >>> 25) & 0x3f;
  const imm4_1 = (instructionWord >>> 8) & 0xf;
  const imm12_0 = (imm12 << 12) | (imm11 << 11) | (imm10_5 << 5) | (imm4_1 << 1);
  return signedNumberToBytes(new Uint8Array(8), imm12_0, 13);
};

/**
 * U-type immediate (lui, auipc).
 *
 *   imm[31:12] = instruction[31:12]
 *   imm[11:0]  = 0
 *
 * Bit 31 is then sign-extended into bits [63:32] of the 64-bit result
 * (RV64 treats the U-immediate as a signed 32-bit value in the low half).
 */
const decodeUTypeImmediate = (instructionWord: number): Uint8Array => {
  const imm31_12_placed = instructionWord & 0xfffff000;
  return signedNumberToBytes(new Uint8Array(8), imm31_12_placed, 32);
};

/**
 * J-type immediate (jal).
 *
 * Jump offsets are multiples of 2; bit 0 of the immediate is always 0.
 * Scattered fields:
 *   imm[20]    = instruction[31]
 *   imm[19:12] = instruction[19:12]
 *   imm[11]    = instruction[20]
 *   imm[10:1]  = instruction[30:21]
 *   imm[0]     = 0
 *
 * Returns that signed 21-bit value as a 64-bit little-endian byte array.
 */
const decodeJTypeImmediate = (instructionWord: number): Uint8Array => {
  const imm20 = (instructionWord >>> 31) & 0x1;
  const imm19_12 = (instructionWord >>> 12) & 0xff;
  const imm11 = (instructionWord >>> 20) & 0x1;
  const imm10_1 = (instructionWord >>> 21) & 0x3ff;
  const imm20_0 = (imm20 << 20) | (imm19_12 << 12) | (imm11 << 11) | (imm10_1 << 1);
  return signedNumberToBytes(new Uint8Array(8), imm20_0, 21);
};

const destinationRegisterOf = (instructionWord: number): number => (instructionWord >>> 7) & 0x1f;
const sourceRegister1Of = (instructionWord: number): number => (instructionWord >>> 15) & 0x1f;
const sourceRegister2Of = (instructionWord: number): number => (instructionWord >>> 20) & 0x1f;
const function3Of = (instructionWord: number): number => (instructionWord >>> 12) & 0x7;
const function7Of = (instructionWord: number): number => (instructionWord >>> 25) & 0x7f;

/**
 * Decode one RV64I instruction into an execute thunk.
 *
 * Only the matched opcode's fields are extracted; execution is delegated to the
 * instruction functions under `src/cpu/instructions/`.
 */
const decode = (
  instructionWord: Uint8Array
): ((registers: Registers, memory: Uint8Array) => void) => {
  const encodedInstructionWord = bytesToNumber(instructionWord);
  const opcode = encodedInstructionWord & 0x7f;

  switch (opcode) {
    case OPCODE_LUI: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const immediate = decodeUTypeImmediate(encodedInstructionWord);
      return (registers, memory) => lui(registers, memory, { destinationRegister, immediate });
    }

    case OPCODE_AUIPC: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const immediate = decodeUTypeImmediate(encodedInstructionWord);
      return (registers, memory) => auipc(registers, memory, { destinationRegister, immediate });
    }

    case OPCODE_JAL: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const immediate = decodeJTypeImmediate(encodedInstructionWord);
      return (registers, memory) => jal(registers, memory, { destinationRegister, immediate });
    }

    case OPCODE_JALR: {
      if (function3Of(encodedInstructionWord) !== 0) {
        return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
      }
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const immediate = decodeITypeImmediate(encodedInstructionWord);
      return (registers, memory) =>
        jalr(registers, memory, { destinationRegister, sourceRegister1, immediate });
    }

    case OPCODE_BRANCH: {
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const sourceRegister2 = sourceRegister2Of(encodedInstructionWord);
      const immediate = decodeBTypeImmediate(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_BEQ:
          return (registers, memory) =>
            beq(registers, memory, { sourceRegister1, sourceRegister2, immediate });
        case FUNCT3_BNE:
          return (registers, memory) =>
            bne(registers, memory, { sourceRegister1, sourceRegister2, immediate });
        case FUNCT3_BLT:
          return (registers, memory) =>
            blt(registers, memory, { sourceRegister1, sourceRegister2, immediate });
        case FUNCT3_BGE:
          return (registers, memory) =>
            bge(registers, memory, { sourceRegister1, sourceRegister2, immediate });
        case FUNCT3_BLTU:
          return (registers, memory) =>
            bltu(registers, memory, { sourceRegister1, sourceRegister2, immediate });
        case FUNCT3_BGEU:
          return (registers, memory) =>
            bgeu(registers, memory, { sourceRegister1, sourceRegister2, immediate });
        default:
          return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_LOAD: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const immediate = decodeITypeImmediate(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_LB:
          return (registers, memory) =>
            lb(registers, memory, { destinationRegister, sourceRegister1, immediate });
        case FUNCT3_LH:
          return (registers, memory) =>
            lh(registers, memory, { destinationRegister, sourceRegister1, immediate });
        case FUNCT3_LW:
          return (registers, memory) =>
            lw(registers, memory, { destinationRegister, sourceRegister1, immediate });
        case FUNCT3_LD:
          return (registers, memory) =>
            ld(registers, memory, { destinationRegister, sourceRegister1, immediate });
        case FUNCT3_LBU:
          return (registers, memory) =>
            lbu(registers, memory, { destinationRegister, sourceRegister1, immediate });
        case FUNCT3_LHU:
          return (registers, memory) =>
            lhu(registers, memory, { destinationRegister, sourceRegister1, immediate });
        case FUNCT3_LWU:
          return (registers, memory) =>
            lwu(registers, memory, { destinationRegister, sourceRegister1, immediate });
        default:
          return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_STORE: {
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const sourceRegister2 = sourceRegister2Of(encodedInstructionWord);
      const immediate = decodeSTypeImmediate(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_SB:
          return (registers, memory) =>
            sb(registers, memory, { sourceRegister1, sourceRegister2, immediate });
        case FUNCT3_SH:
          return (registers, memory) =>
            sh(registers, memory, { sourceRegister1, sourceRegister2, immediate });
        case FUNCT3_SW:
          return (registers, memory) =>
            sw(registers, memory, { sourceRegister1, sourceRegister2, immediate });
        case FUNCT3_SD:
          return (registers, memory) =>
            sd(registers, memory, { sourceRegister1, sourceRegister2, immediate });
        default:
          return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_OP_IMM: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_ADD_SUB: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory) =>
            addi(registers, memory, { destinationRegister, sourceRegister1, immediate });
        }
        case FUNCT3_SLT: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory) =>
            slti(registers, memory, { destinationRegister, sourceRegister1, immediate });
        }
        case FUNCT3_SLTU: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory) =>
            sltiu(registers, memory, { destinationRegister, sourceRegister1, immediate });
        }
        case FUNCT3_XOR: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory) =>
            xori(registers, memory, { destinationRegister, sourceRegister1, immediate });
        }
        case FUNCT3_OR: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory) =>
            ori(registers, memory, { destinationRegister, sourceRegister1, immediate });
        }
        case FUNCT3_AND: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory) =>
            andi(registers, memory, { destinationRegister, sourceRegister1, immediate });
        }
        case FUNCT3_SLL: {
          if (((encodedInstructionWord >>> 26) & 0x3f) !== 0) {
            return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
          }
          const shiftAmount = (encodedInstructionWord >>> 20) & 0x3f;
          return (registers, memory) =>
            slli(registers, memory, { destinationRegister, sourceRegister1, shiftAmount });
        }
        case FUNCT3_SRL_SRA: {
          const bits31_26 = (encodedInstructionWord >>> 26) & 0x3f;
          const shiftAmount = (encodedInstructionWord >>> 20) & 0x3f;
          if (bits31_26 === 0b000000) {
            return (registers, memory) =>
              srli(registers, memory, { destinationRegister, sourceRegister1, shiftAmount });
          }
          if (bits31_26 === 0b010000) {
            return (registers, memory) =>
              srai(registers, memory, { destinationRegister, sourceRegister1, shiftAmount });
          }
          return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
        }
        default:
          return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_OP: {
      const function7 = function7Of(encodedInstructionWord);
      if (function7 !== FUNCT7_NORMAL && function7 !== FUNCT7_SUB_SRA) {
        return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
      }
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const sourceRegister2 = sourceRegister2Of(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_ADD_SUB:
          if (function7 === FUNCT7_NORMAL) {
            return (registers, memory) =>
              add(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
          }
          return (registers, memory) =>
            sub(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
        case FUNCT3_SLL:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory) =>
            sll(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
        case FUNCT3_SLT:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory) =>
            slt(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
        case FUNCT3_SLTU:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory) =>
            sltu(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
        case FUNCT3_XOR:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory) =>
            xor(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
        case FUNCT3_SRL_SRA:
          if (function7 === FUNCT7_NORMAL) {
            return (registers, memory) =>
              srl(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
          }
          return (registers, memory) =>
            sra(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
        case FUNCT3_OR:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory) =>
            or(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
        case FUNCT3_AND:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory) =>
            and(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
        default:
          return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_OP_IMM_32: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_ADD_SUB: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory) =>
            addiw(registers, memory, { destinationRegister, sourceRegister1, immediate });
        }
        case FUNCT3_SLL: {
          if (function7Of(encodedInstructionWord) !== FUNCT7_NORMAL) {
            return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
          }
          const shiftAmount = (encodedInstructionWord >>> 20) & 0x1f;
          return (registers, memory) =>
            slliw(registers, memory, { destinationRegister, sourceRegister1, shiftAmount });
        }
        case FUNCT3_SRL_SRA: {
          const function7 = function7Of(encodedInstructionWord);
          const shiftAmount = (encodedInstructionWord >>> 20) & 0x1f;
          if (function7 === FUNCT7_NORMAL) {
            return (registers, memory) =>
              srliw(registers, memory, { destinationRegister, sourceRegister1, shiftAmount });
          }
          if (function7 === FUNCT7_SUB_SRA) {
            return (registers, memory) =>
              sraiw(registers, memory, { destinationRegister, sourceRegister1, shiftAmount });
          }
          return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
        }
        default:
          return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_OP_32: {
      const function7 = function7Of(encodedInstructionWord);
      if (function7 !== FUNCT7_NORMAL && function7 !== FUNCT7_SUB_SRA) {
        return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
      }
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const sourceRegister2 = sourceRegister2Of(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_ADD_SUB:
          if (function7 === FUNCT7_NORMAL) {
            return (registers, memory) =>
              addw(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
          }
          return (registers, memory) =>
            subw(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
        case FUNCT3_SLL:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory) =>
            sllw(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
        case FUNCT3_SRL_SRA:
          if (function7 === FUNCT7_NORMAL) {
            return (registers, memory) =>
              srlw(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
          }
          return (registers, memory) =>
            sraw(registers, memory, { destinationRegister, sourceRegister1, sourceRegister2 });
        default:
          return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_MISC_MEM: {
      if (function3Of(encodedInstructionWord) === FUNCT3_FENCE) {
        return (registers, memory) => fence(registers, memory);
      }
      return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
    }

    case OPCODE_SYSTEM: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const controlAndStatusRegister = encodedInstructionWord >>> 20;
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_SYSTEM:
          if (controlAndStatusRegister === 0) {
            return (registers, memory) => ecall(registers, memory);
          }
          if (controlAndStatusRegister === 1) {
            return (registers, memory) => ebreak(registers, memory);
          }
          if (controlAndStatusRegister === FUNCT12_MRET) {
            if (destinationRegister !== 0 || sourceRegister1 !== 0) {
              return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
            }
            return (registers, memory) => mret(registers, memory);
          }
          return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
        case FUNCT3_CSRRW:
          return (registers, memory) =>
            csrrw(registers, memory, {
              destinationRegister,
              sourceRegister1,
              controlAndStatusRegister,
            });
        case FUNCT3_CSRRS:
          return (registers, memory) =>
            csrrs(registers, memory, {
              destinationRegister,
              sourceRegister1,
              controlAndStatusRegister,
            });
        case FUNCT3_CSRRC:
          return (registers, memory) =>
            csrrc(registers, memory, {
              destinationRegister,
              sourceRegister1,
              controlAndStatusRegister,
            });
        case FUNCT3_CSRRWI:
          return (registers, memory) =>
            csrrwi(registers, memory, {
              destinationRegister,
              immediate: signedNumberToBytes(new Uint8Array(8), sourceRegister1, 32),
              controlAndStatusRegister,
            });
        case FUNCT3_CSRRSI:
          return (registers, memory) =>
            csrrsi(registers, memory, {
              destinationRegister,
              immediate: signedNumberToBytes(new Uint8Array(8), sourceRegister1, 32),
              controlAndStatusRegister,
            });
        case FUNCT3_CSRRCI:
          return (registers, memory) =>
            csrrci(registers, memory, {
              destinationRegister,
              immediate: signedNumberToBytes(new Uint8Array(8), sourceRegister1, 32),
              controlAndStatusRegister,
            });
        default:
          return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
      }
    }

    default:
      return (registers, _memory) => illegalInstruction(registers, encodedInstructionWord);
  }
};

const thunkByInstructionWord = new Map<number, ReturnType<typeof decode>>();

/**
 * Like {@link decode}, but memoizes thunks by the 32-bit instruction encoding.
 * Identical encodings share one thunk regardless of where they appear in memory.
 */
const decodeWithCache = (instructionWord: Uint8Array): ReturnType<typeof decode> => {
  const key = bytesToNumber(instructionWord);
  if (thunkByInstructionWord.has(key)) {
    return thunkByInstructionWord.get(key)!;
  }
  const thunk = decode(instructionWord);
  thunkByInstructionWord.set(key, thunk);
  return thunk;
};

export default decodeWithCache;
