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

import { signedNumberToBytes } from '#utils/bytes';
import type { Registers } from '#emulator/cpu/types';
import type { Memory } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';
import { lui } from '#emulator/cpu/instructions/lui';
import { auipc } from '#emulator/cpu/instructions/auipc';
import { jal } from '#emulator/cpu/instructions/jal';
import { jalr } from '#emulator/cpu/instructions/jalr';
import { beq, bne, blt, bge, bltu, bgeu } from '#emulator/cpu/instructions/branch';
import { lb, lh, lw, ld, lbu, lhu, lwu } from '#emulator/cpu/instructions/load';
import { sb, sh, sw, sd } from '#emulator/cpu/instructions/store';
import {
  lrW,
  lrD,
  scW,
  scD,
  amoswapW,
  amoswapD,
  amoaddW,
  amoaddD,
  amoxorW,
  amoxorD,
  amoandW,
  amoandD,
  amoorW,
  amoorD,
  amominW,
  amominD,
  amomaxW,
  amomaxD,
  amominuW,
  amominuD,
  amomaxuW,
  amomaxuD,
} from '#emulator/cpu/instructions/amo';
import {
  addi,
  slti,
  sltiu,
  xori,
  ori,
  andi,
  slli,
  srli,
  srai,
} from '#emulator/cpu/instructions/op-imm';
import { add, sub, sll, slt, sltu, xor, srl, sra, or, and } from '#emulator/cpu/instructions/op';
import { mul, mulh, mulhsu, mulhu, div, divu, rem, remu } from '#emulator/cpu/instructions/op-m';
import { addiw, slliw, srliw, sraiw } from '#emulator/cpu/instructions/op-imm-32';
import { addw, subw, sllw, srlw, sraw } from '#emulator/cpu/instructions/op-32';
import { mulw, divw, divuw, remw, remuw } from '#emulator/cpu/instructions/op-32-m';
import fence from '#emulator/cpu/instructions/misc-mem';
import {
  ecall,
  ebreak,
  mret,
  sret,
  wfi,
  csrrw,
  csrrs,
  csrrc,
  csrrwi,
  csrrsi,
  csrrci,
} from '#emulator/cpu/instructions/system';
import { CAUSE_ILLEGAL_INSTRUCTION, enterTrap, instructionWordTrapValue } from '#emulator/cpu/trap';

type ExecuteThunk = (
  registers: Registers,
  memory: Memory,
  instructionByteLength: ReadonlyUint8Array
) => void | Promise<void>;

const OPCODE_LOAD = 0x03; // loads: lb/lh/lw/ld/lbu/lhu/lwu
const OPCODE_MISC_MEM = 0x0f; // fence (memory ordering)
const OPCODE_OP_IMM = 0x13; // integer ops with immediate: addi/slti/…/andi/slli/srli/srai
const OPCODE_AUIPC = 0x17; // add upper immediate to pc
const OPCODE_OP_IMM_32 = 0x1b; // 32-bit integer ops with immediate (RV64): addiw/slliw/srliw/sraiw
const OPCODE_STORE = 0x23; // stores: sb/sh/sw/sd
const OPCODE_AMO = 0x2f; // atomics (A): lr/sc/amoswap/amoadd/…
const OPCODE_OP = 0x33; // register–register integer ops: add/sub/sll/…/and
const OPCODE_LUI = 0x37; // load upper immediate
const OPCODE_OP_32 = 0x3b; // 32-bit register–register ops (RV64): addw/subw/sllw/srlw/sraw
const OPCODE_BRANCH = 0x63; // conditional branches: beq/bne/blt/bge/bltu/bgeu
const OPCODE_JALR = 0x67; // jump and link register
const OPCODE_JAL = 0x6f; // jump and link
const OPCODE_SYSTEM = 0x73; // system: ecall/ebreak/mret/sret/wfi/csrrw/csrrs/csrrc/csrrwi/csrrsi/csrrci

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

const FUNCT3_AMO_W = 0x2; // AMO / LR / SC 32-bit
const FUNCT3_AMO_D = 0x3; // AMO / LR / SC 64-bit

const FUNCT5_AMOADD = 0x00; // atomic add
const FUNCT5_AMOSWAP = 0x01; // atomic swap
const FUNCT5_LR = 0x02; // load-reserved
const FUNCT5_SC = 0x03; // store-conditional
const FUNCT5_AMOXOR = 0x04; // atomic xor
const FUNCT5_AMOOR = 0x08; // atomic or
const FUNCT5_AMOAND = 0x0c; // atomic and
const FUNCT5_AMOMIN = 0x10; // atomic signed min
const FUNCT5_AMOMAX = 0x14; // atomic signed max
const FUNCT5_AMOMINU = 0x18; // atomic unsigned min
const FUNCT5_AMOMAXU = 0x1c; // atomic unsigned max

const FUNCT3_FENCE = 0x0; // fence under MISC-MEM
const FUNCT3_SYSTEM = 0x0; // ecall/ebreak/mret/sret under SYSTEM (distinguished by imm)
const FUNCT3_CSRRW = 0x1; // atomic CSR read/write
const FUNCT3_CSRRS = 0x2; // atomic CSR read and set
const FUNCT3_CSRRC = 0x3; // atomic CSR read and clear
const FUNCT3_CSRRWI = 0x5; // atomic CSR read/write immediate
const FUNCT3_CSRRSI = 0x6; // atomic CSR read and set immediate
const FUNCT3_CSRRCI = 0x7; // atomic CSR read and clear immediate

/** funct12 for ecall / ebreak / sret / wfi / mret (imm[11:0] when funct3 = SYSTEM). */
const FUNCT12_ECALL = 0x000;
const FUNCT12_EBREAK = 0x001;
const FUNCT12_SRET = 0x102;
const FUNCT12_WFI = 0x105;
const FUNCT12_MRET = 0x302;

const FUNCT7_NORMAL = 0x00; // default funct7: add/sll/srl/…
const FUNCT7_MUL_DIV = 0x01; // M extension: mul/div/rem (and *w forms on OP-32)
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
const decodeITypeImmediate = (instructionWord: number): ReadonlyUint8Array => {
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
const decodeSTypeImmediate = (instructionWord: number): ReadonlyUint8Array => {
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
const decodeBTypeImmediate = (instructionWord: number): ReadonlyUint8Array => {
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
const decodeUTypeImmediate = (instructionWord: number): ReadonlyUint8Array => {
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
const decodeJTypeImmediate = (instructionWord: number): ReadonlyUint8Array => {
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
 * Decode one 32-bit RV64IMA encoding into an execute thunk.
 * Caller passes `FOUR_BYTES` when invoking the thunk.
 */
const decode32 = (encodedInstructionWord: number): ExecuteThunk => {
  const opcode = encodedInstructionWord & 0x7f;

  switch (opcode) {
    case OPCODE_LUI: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const immediate = decodeUTypeImmediate(encodedInstructionWord);
      return (registers, memory, instructionByteLength) =>
        lui(registers, memory, { destinationRegister, immediate }, instructionByteLength);
    }

    case OPCODE_AUIPC: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const immediate = decodeUTypeImmediate(encodedInstructionWord);
      return (registers, memory, instructionByteLength) =>
        auipc(registers, memory, { destinationRegister, immediate }, instructionByteLength);
    }

    case OPCODE_JAL: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const immediate = decodeJTypeImmediate(encodedInstructionWord);
      return (registers, memory, instructionByteLength) =>
        jal(registers, memory, { destinationRegister, immediate }, instructionByteLength);
    }

    case OPCODE_JALR: {
      if (function3Of(encodedInstructionWord) !== 0) {
        return (registers, _memory, _instructionByteLength) =>
          illegalInstruction(registers, encodedInstructionWord);
      }
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const immediate = decodeITypeImmediate(encodedInstructionWord);
      return (registers, memory, instructionByteLength) =>
        jalr(
          registers,
          memory,
          { destinationRegister, sourceRegister1, immediate },
          instructionByteLength
        );
    }

    case OPCODE_BRANCH: {
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const sourceRegister2 = sourceRegister2Of(encodedInstructionWord);
      const immediate = decodeBTypeImmediate(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_BEQ:
          return (registers, memory, instructionByteLength) =>
            beq(
              registers,
              memory,
              { sourceRegister1, sourceRegister2, immediate },
              instructionByteLength
            );
        case FUNCT3_BNE:
          return (registers, memory, instructionByteLength) =>
            bne(
              registers,
              memory,
              { sourceRegister1, sourceRegister2, immediate },
              instructionByteLength
            );
        case FUNCT3_BLT:
          return (registers, memory, instructionByteLength) =>
            blt(
              registers,
              memory,
              { sourceRegister1, sourceRegister2, immediate },
              instructionByteLength
            );
        case FUNCT3_BGE:
          return (registers, memory, instructionByteLength) =>
            bge(
              registers,
              memory,
              { sourceRegister1, sourceRegister2, immediate },
              instructionByteLength
            );
        case FUNCT3_BLTU:
          return (registers, memory, instructionByteLength) =>
            bltu(
              registers,
              memory,
              { sourceRegister1, sourceRegister2, immediate },
              instructionByteLength
            );
        case FUNCT3_BGEU:
          return (registers, memory, instructionByteLength) =>
            bgeu(
              registers,
              memory,
              { sourceRegister1, sourceRegister2, immediate },
              instructionByteLength
            );
        default:
          return (registers, _memory, _instructionByteLength) =>
            illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_LOAD: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const immediate = decodeITypeImmediate(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_LB:
          return (registers, memory, instructionByteLength) =>
            lb(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        case FUNCT3_LH:
          return (registers, memory, instructionByteLength) =>
            lh(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        case FUNCT3_LW:
          return (registers, memory, instructionByteLength) =>
            lw(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        case FUNCT3_LD:
          return (registers, memory, instructionByteLength) =>
            ld(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        case FUNCT3_LBU:
          return (registers, memory, instructionByteLength) =>
            lbu(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        case FUNCT3_LHU:
          return (registers, memory, instructionByteLength) =>
            lhu(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        case FUNCT3_LWU:
          return (registers, memory, instructionByteLength) =>
            lwu(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        default:
          return (registers, _memory, _instructionByteLength) =>
            illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_STORE: {
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const sourceRegister2 = sourceRegister2Of(encodedInstructionWord);
      const immediate = decodeSTypeImmediate(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_SB:
          return (registers, memory, instructionByteLength) =>
            sb(
              registers,
              memory,
              { sourceRegister1, sourceRegister2, immediate },
              instructionByteLength
            );
        case FUNCT3_SH:
          return (registers, memory, instructionByteLength) =>
            sh(
              registers,
              memory,
              { sourceRegister1, sourceRegister2, immediate },
              instructionByteLength
            );
        case FUNCT3_SW:
          return (registers, memory, instructionByteLength) =>
            sw(
              registers,
              memory,
              { sourceRegister1, sourceRegister2, immediate },
              instructionByteLength
            );
        case FUNCT3_SD:
          return (registers, memory, instructionByteLength) =>
            sd(
              registers,
              memory,
              { sourceRegister1, sourceRegister2, immediate },
              instructionByteLength
            );
        default:
          return (registers, _memory, _instructionByteLength) =>
            illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_AMO: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const sourceRegister2 = sourceRegister2Of(encodedInstructionWord);
      const function5 = encodedInstructionWord >>> 27;
      const args = { destinationRegister, sourceRegister1, sourceRegister2 };
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_AMO_W:
          switch (function5) {
            case FUNCT5_LR:
              if (sourceRegister2 !== 0) {
                return (registers, _memory, _instructionByteLength) =>
                  illegalInstruction(registers, encodedInstructionWord);
              }
              return (registers, memory, instructionByteLength) =>
                lrW(registers, memory, args, instructionByteLength);
            case FUNCT5_SC:
              return (registers, memory, instructionByteLength) =>
                scW(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOSWAP:
              return (registers, memory, instructionByteLength) =>
                amoswapW(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOADD:
              return (registers, memory, instructionByteLength) =>
                amoaddW(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOXOR:
              return (registers, memory, instructionByteLength) =>
                amoxorW(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOOR:
              return (registers, memory, instructionByteLength) =>
                amoorW(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOAND:
              return (registers, memory, instructionByteLength) =>
                amoandW(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOMIN:
              return (registers, memory, instructionByteLength) =>
                amominW(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOMAX:
              return (registers, memory, instructionByteLength) =>
                amomaxW(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOMINU:
              return (registers, memory, instructionByteLength) =>
                amominuW(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOMAXU:
              return (registers, memory, instructionByteLength) =>
                amomaxuW(registers, memory, args, instructionByteLength);
            default:
              return (registers, _memory, _instructionByteLength) =>
                illegalInstruction(registers, encodedInstructionWord);
          }
        case FUNCT3_AMO_D:
          switch (function5) {
            case FUNCT5_LR:
              if (sourceRegister2 !== 0) {
                return (registers, _memory, _instructionByteLength) =>
                  illegalInstruction(registers, encodedInstructionWord);
              }
              return (registers, memory, instructionByteLength) =>
                lrD(registers, memory, args, instructionByteLength);
            case FUNCT5_SC:
              return (registers, memory, instructionByteLength) =>
                scD(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOSWAP:
              return (registers, memory, instructionByteLength) =>
                amoswapD(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOADD:
              return (registers, memory, instructionByteLength) =>
                amoaddD(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOXOR:
              return (registers, memory, instructionByteLength) =>
                amoxorD(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOOR:
              return (registers, memory, instructionByteLength) =>
                amoorD(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOAND:
              return (registers, memory, instructionByteLength) =>
                amoandD(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOMIN:
              return (registers, memory, instructionByteLength) =>
                amominD(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOMAX:
              return (registers, memory, instructionByteLength) =>
                amomaxD(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOMINU:
              return (registers, memory, instructionByteLength) =>
                amominuD(registers, memory, args, instructionByteLength);
            case FUNCT5_AMOMAXU:
              return (registers, memory, instructionByteLength) =>
                amomaxuD(registers, memory, args, instructionByteLength);
            default:
              return (registers, _memory, _instructionByteLength) =>
                illegalInstruction(registers, encodedInstructionWord);
          }
        default:
          return (registers, _memory, _instructionByteLength) =>
            illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_OP_IMM: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_ADD_SUB: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory, instructionByteLength) =>
            addi(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        }
        case FUNCT3_SLT: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory, instructionByteLength) =>
            slti(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        }
        case FUNCT3_SLTU: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory, instructionByteLength) =>
            sltiu(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        }
        case FUNCT3_XOR: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory, instructionByteLength) =>
            xori(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        }
        case FUNCT3_OR: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory, instructionByteLength) =>
            ori(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        }
        case FUNCT3_AND: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory, instructionByteLength) =>
            andi(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        }
        case FUNCT3_SLL: {
          if (((encodedInstructionWord >>> 26) & 0x3f) !== 0) {
            return (registers, _memory, _instructionByteLength) =>
              illegalInstruction(registers, encodedInstructionWord);
          }
          const shiftAmount = (encodedInstructionWord >>> 20) & 0x3f;
          return (registers, memory, instructionByteLength) =>
            slli(
              registers,
              memory,
              { destinationRegister, sourceRegister1, shiftAmount },
              instructionByteLength
            );
        }
        case FUNCT3_SRL_SRA: {
          const bits31_26 = (encodedInstructionWord >>> 26) & 0x3f;
          const shiftAmount = (encodedInstructionWord >>> 20) & 0x3f;
          if (bits31_26 === 0b000000) {
            return (registers, memory, instructionByteLength) =>
              srli(
                registers,
                memory,
                { destinationRegister, sourceRegister1, shiftAmount },
                instructionByteLength
              );
          }
          if (bits31_26 === 0b010000) {
            return (registers, memory, instructionByteLength) =>
              srai(
                registers,
                memory,
                { destinationRegister, sourceRegister1, shiftAmount },
                instructionByteLength
              );
          }
          return (registers, _memory, _instructionByteLength) =>
            illegalInstruction(registers, encodedInstructionWord);
        }
        default:
          return (registers, _memory, _instructionByteLength) =>
            illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_OP: {
      const function7 = function7Of(encodedInstructionWord);
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const sourceRegister2 = sourceRegister2Of(encodedInstructionWord);
      if (function7 === FUNCT7_MUL_DIV) {
        switch (function3Of(encodedInstructionWord)) {
          case FUNCT3_ADD_SUB:
            return (registers, memory, instructionByteLength) =>
              mul(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          case FUNCT3_SLL:
            return (registers, memory, instructionByteLength) =>
              mulh(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          case FUNCT3_SLT:
            return (registers, memory, instructionByteLength) =>
              mulhsu(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          case FUNCT3_SLTU:
            return (registers, memory, instructionByteLength) =>
              mulhu(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          case FUNCT3_XOR:
            return (registers, memory, instructionByteLength) =>
              div(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          case FUNCT3_SRL_SRA:
            return (registers, memory, instructionByteLength) =>
              divu(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          case FUNCT3_OR:
            return (registers, memory, instructionByteLength) =>
              rem(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          case FUNCT3_AND:
            return (registers, memory, instructionByteLength) =>
              remu(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          default:
            return (registers, _memory, _instructionByteLength) =>
              illegalInstruction(registers, encodedInstructionWord);
        }
      }
      if (function7 !== FUNCT7_NORMAL && function7 !== FUNCT7_SUB_SRA) {
        return (registers, _memory, _instructionByteLength) =>
          illegalInstruction(registers, encodedInstructionWord);
      }
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_ADD_SUB:
          if (function7 === FUNCT7_NORMAL) {
            return (registers, memory, instructionByteLength) =>
              add(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          }
          return (registers, memory, instructionByteLength) =>
            sub(
              registers,
              memory,
              { destinationRegister, sourceRegister1, sourceRegister2 },
              instructionByteLength
            );
        case FUNCT3_SLL:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory, _instructionByteLength) =>
              illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory, instructionByteLength) =>
            sll(
              registers,
              memory,
              { destinationRegister, sourceRegister1, sourceRegister2 },
              instructionByteLength
            );
        case FUNCT3_SLT:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory, _instructionByteLength) =>
              illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory, instructionByteLength) =>
            slt(
              registers,
              memory,
              { destinationRegister, sourceRegister1, sourceRegister2 },
              instructionByteLength
            );
        case FUNCT3_SLTU:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory, _instructionByteLength) =>
              illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory, instructionByteLength) =>
            sltu(
              registers,
              memory,
              { destinationRegister, sourceRegister1, sourceRegister2 },
              instructionByteLength
            );
        case FUNCT3_XOR:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory, _instructionByteLength) =>
              illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory, instructionByteLength) =>
            xor(
              registers,
              memory,
              { destinationRegister, sourceRegister1, sourceRegister2 },
              instructionByteLength
            );
        case FUNCT3_SRL_SRA:
          if (function7 === FUNCT7_NORMAL) {
            return (registers, memory, instructionByteLength) =>
              srl(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          }
          return (registers, memory, instructionByteLength) =>
            sra(
              registers,
              memory,
              { destinationRegister, sourceRegister1, sourceRegister2 },
              instructionByteLength
            );
        case FUNCT3_OR:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory, _instructionByteLength) =>
              illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory, instructionByteLength) =>
            or(
              registers,
              memory,
              { destinationRegister, sourceRegister1, sourceRegister2 },
              instructionByteLength
            );
        case FUNCT3_AND:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory, _instructionByteLength) =>
              illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory, instructionByteLength) =>
            and(
              registers,
              memory,
              { destinationRegister, sourceRegister1, sourceRegister2 },
              instructionByteLength
            );
        default:
          return (registers, _memory, _instructionByteLength) =>
            illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_OP_IMM_32: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_ADD_SUB: {
          const immediate = decodeITypeImmediate(encodedInstructionWord);
          return (registers, memory, instructionByteLength) =>
            addiw(
              registers,
              memory,
              { destinationRegister, sourceRegister1, immediate },
              instructionByteLength
            );
        }
        case FUNCT3_SLL: {
          if (function7Of(encodedInstructionWord) !== FUNCT7_NORMAL) {
            return (registers, _memory, _instructionByteLength) =>
              illegalInstruction(registers, encodedInstructionWord);
          }
          const shiftAmount = (encodedInstructionWord >>> 20) & 0x1f;
          return (registers, memory, instructionByteLength) =>
            slliw(
              registers,
              memory,
              { destinationRegister, sourceRegister1, shiftAmount },
              instructionByteLength
            );
        }
        case FUNCT3_SRL_SRA: {
          const function7 = function7Of(encodedInstructionWord);
          const shiftAmount = (encodedInstructionWord >>> 20) & 0x1f;
          if (function7 === FUNCT7_NORMAL) {
            return (registers, memory, instructionByteLength) =>
              srliw(
                registers,
                memory,
                { destinationRegister, sourceRegister1, shiftAmount },
                instructionByteLength
              );
          }
          if (function7 === FUNCT7_SUB_SRA) {
            return (registers, memory, instructionByteLength) =>
              sraiw(
                registers,
                memory,
                { destinationRegister, sourceRegister1, shiftAmount },
                instructionByteLength
              );
          }
          return (registers, _memory, _instructionByteLength) =>
            illegalInstruction(registers, encodedInstructionWord);
        }
        default:
          return (registers, _memory, _instructionByteLength) =>
            illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_OP_32: {
      const function7 = function7Of(encodedInstructionWord);
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const sourceRegister2 = sourceRegister2Of(encodedInstructionWord);
      if (function7 === FUNCT7_MUL_DIV) {
        switch (function3Of(encodedInstructionWord)) {
          case FUNCT3_ADD_SUB:
            return (registers, memory, instructionByteLength) =>
              mulw(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          case FUNCT3_XOR:
            return (registers, memory, instructionByteLength) =>
              divw(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          case FUNCT3_SRL_SRA:
            return (registers, memory, instructionByteLength) =>
              divuw(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          case FUNCT3_OR:
            return (registers, memory, instructionByteLength) =>
              remw(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          case FUNCT3_AND:
            return (registers, memory, instructionByteLength) =>
              remuw(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          default:
            return (registers, _memory, _instructionByteLength) =>
              illegalInstruction(registers, encodedInstructionWord);
        }
      }
      if (function7 !== FUNCT7_NORMAL && function7 !== FUNCT7_SUB_SRA) {
        return (registers, _memory, _instructionByteLength) =>
          illegalInstruction(registers, encodedInstructionWord);
      }
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_ADD_SUB:
          if (function7 === FUNCT7_NORMAL) {
            return (registers, memory, instructionByteLength) =>
              addw(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          }
          return (registers, memory, instructionByteLength) =>
            subw(
              registers,
              memory,
              { destinationRegister, sourceRegister1, sourceRegister2 },
              instructionByteLength
            );
        case FUNCT3_SLL:
          if (function7 !== FUNCT7_NORMAL) {
            return (registers, _memory, _instructionByteLength) =>
              illegalInstruction(registers, encodedInstructionWord);
          }
          return (registers, memory, instructionByteLength) =>
            sllw(
              registers,
              memory,
              { destinationRegister, sourceRegister1, sourceRegister2 },
              instructionByteLength
            );
        case FUNCT3_SRL_SRA:
          if (function7 === FUNCT7_NORMAL) {
            return (registers, memory, instructionByteLength) =>
              srlw(
                registers,
                memory,
                { destinationRegister, sourceRegister1, sourceRegister2 },
                instructionByteLength
              );
          }
          return (registers, memory, instructionByteLength) =>
            sraw(
              registers,
              memory,
              { destinationRegister, sourceRegister1, sourceRegister2 },
              instructionByteLength
            );
        default:
          return (registers, _memory, _instructionByteLength) =>
            illegalInstruction(registers, encodedInstructionWord);
      }
    }

    case OPCODE_MISC_MEM: {
      if (function3Of(encodedInstructionWord) === FUNCT3_FENCE) {
        return (registers, memory, instructionByteLength) =>
          fence(registers, memory, instructionByteLength);
      }
      return (registers, _memory, _instructionByteLength) =>
        illegalInstruction(registers, encodedInstructionWord);
    }

    case OPCODE_SYSTEM: {
      const destinationRegister = destinationRegisterOf(encodedInstructionWord);
      const sourceRegister1 = sourceRegister1Of(encodedInstructionWord);
      const controlAndStatusRegister = encodedInstructionWord >>> 20;
      switch (function3Of(encodedInstructionWord)) {
        case FUNCT3_SYSTEM:
          switch (controlAndStatusRegister) {
            case FUNCT12_ECALL:
              if (destinationRegister !== 0 || sourceRegister1 !== 0) {
                return (registers, _memory, _instructionByteLength) =>
                  illegalInstruction(registers, encodedInstructionWord);
              }
              return (registers, memory, instructionByteLength) =>
                ecall(registers, memory, instructionByteLength);
            case FUNCT12_EBREAK:
              if (destinationRegister !== 0 || sourceRegister1 !== 0) {
                return (registers, _memory, _instructionByteLength) =>
                  illegalInstruction(registers, encodedInstructionWord);
              }
              return (registers, memory, instructionByteLength) =>
                ebreak(registers, memory, instructionByteLength);
            case FUNCT12_SRET:
              if (destinationRegister !== 0 || sourceRegister1 !== 0) {
                return (registers, _memory, _instructionByteLength) =>
                  illegalInstruction(registers, encodedInstructionWord);
              }
              return (registers, memory, instructionByteLength) =>
                sret(registers, memory, instructionByteLength);
            case FUNCT12_WFI:
              if (destinationRegister !== 0 || sourceRegister1 !== 0) {
                return (registers, _memory, _instructionByteLength) =>
                  illegalInstruction(registers, encodedInstructionWord);
              }
              return (registers, memory, instructionByteLength) =>
                wfi(registers, memory, instructionByteLength);
            case FUNCT12_MRET:
              if (destinationRegister !== 0 || sourceRegister1 !== 0) {
                return (registers, _memory, _instructionByteLength) =>
                  illegalInstruction(registers, encodedInstructionWord);
              }
              return (registers, memory, instructionByteLength) =>
                mret(registers, memory, instructionByteLength);
            default:
              return (registers, _memory, _instructionByteLength) =>
                illegalInstruction(registers, encodedInstructionWord);
          }
        case FUNCT3_CSRRW:
          return (registers, memory, instructionByteLength) =>
            csrrw(
              registers,
              memory,
              {
                destinationRegister,
                sourceRegister1,
                controlAndStatusRegister,
                instructionWord: encodedInstructionWord,
              },
              instructionByteLength
            );
        case FUNCT3_CSRRS:
          return (registers, memory, instructionByteLength) =>
            csrrs(
              registers,
              memory,
              {
                destinationRegister,
                sourceRegister1,
                controlAndStatusRegister,
                instructionWord: encodedInstructionWord,
              },
              instructionByteLength
            );
        case FUNCT3_CSRRC:
          return (registers, memory, instructionByteLength) =>
            csrrc(
              registers,
              memory,
              {
                destinationRegister,
                sourceRegister1,
                controlAndStatusRegister,
                instructionWord: encodedInstructionWord,
              },
              instructionByteLength
            );
        case FUNCT3_CSRRWI:
          return (registers, memory, instructionByteLength) =>
            csrrwi(
              registers,
              memory,
              {
                destinationRegister,
                immediate: signedNumberToBytes(new Uint8Array(8), sourceRegister1, 32),
                controlAndStatusRegister,
                instructionWord: encodedInstructionWord,
              },
              instructionByteLength
            );
        case FUNCT3_CSRRSI:
          return (registers, memory, instructionByteLength) =>
            csrrsi(
              registers,
              memory,
              {
                destinationRegister,
                immediate: signedNumberToBytes(new Uint8Array(8), sourceRegister1, 32),
                controlAndStatusRegister,
                instructionWord: encodedInstructionWord,
              },
              instructionByteLength
            );
        case FUNCT3_CSRRCI:
          return (registers, memory, instructionByteLength) =>
            csrrci(
              registers,
              memory,
              {
                destinationRegister,
                immediate: signedNumberToBytes(new Uint8Array(8), sourceRegister1, 32),
                controlAndStatusRegister,
                instructionWord: encodedInstructionWord,
              },
              instructionByteLength
            );
        default:
          return (registers, _memory, _instructionByteLength) =>
            illegalInstruction(registers, encodedInstructionWord);
      }
    }

    default:
      return (registers, _memory, _instructionByteLength) =>
        illegalInstruction(registers, encodedInstructionWord);
  }
};

export default decode32;
