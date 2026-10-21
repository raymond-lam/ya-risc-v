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
import { setTimeout as delay } from 'node:timers/promises';
import testMemory from '#test/guest-memory';
import { isClintSupervisorTimerPending, tickClint } from '#emulator/clint';
import decode from '#emulator/cpu/decode';
import {
  csrrc,
  csrrci,
  csrrs,
  csrrsi,
  csrrw,
  csrrwi,
  ebreak,
  ecall,
  mret,
  sret,
  sfenceVma,
  wfi,
} from '#emulator/cpu/instructions/system';
import {
  MCAUSE,
  MEPC,
  MIE,
  MIP,
  MSTATUS,
  MTVAL,
  MTVEC,
  PRIVILEGE_MACHINE,
  PRIVILEGE_SUPERVISOR,
  PRIVILEGE_USER,
  SEPC,
  beginInstructionRetire,
  commitInstructionRetire,
  createRegisters,
  snapshotControlAndStatusRegister,
  readGeneralPurposeRegister,
  readPrivilegeMode,
  readProgramCounter,
  setPrivilegeMode,
  setProgramCounter,
  setSupervisorTimerInterruptPending,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
  publishSupervisorTimerCompare,
  FOUR_BYTES,
} from '#emulator/cpu/registers';
import { CAUSE_BREAKPOINT, CAUSE_ILLEGAL_INSTRUCTION } from '#emulator/cpu/trap';

/** CSR addresses used only in these tests (not part of the registers public surface). */
const MISA = 0x301;
const MSCRATCH = 0x340;
const SSCRATCH = 0x140;
const SATP = 0x180;
const CYCLE = 0xc00;
const TIME = 0xc01;
const INSTRET = 0xc02;
const MCYCLE = 0xb00;
const MINSTRET = 0xb02;
const MCOUNTEREN = 0x306;
const SCOUNTEREN = 0x106;
const MCOUNTINHIBIT = 0x320;
const MENVCFG = 0x30a;
const STIMECMP = 0x14d;
import { storeBytes, type Memory } from '#emulator/memory';
import {
  bytesToBigInt,
  bytesToNumber,
  signedNumberToBytes,
  unsignedBigIntToBytes,
  unsignedNumberToBytes,
} from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';

/** mie bit for machine timer interrupt (cause 7). */
const MIE_MTIE = 1 << 7;
/** mie/sie bit for supervisor timer interrupt (cause 5). */
const MIE_STIE = 1 << 5;

/** menvcfg.STCE (bit 63) — enables Sstc `stimecmp` / hardware STIP. */
const MENVCFG_STCE = unsignedBigIntToBytes(new Uint8Array(8), 1n << 63n) as ReadonlyUint8Array;
/** menvcfg WARL keeps STCE (63); ADUE (61) and the cache-block bits stay read-only zero. */
const MENVCFG_WARL_KEEP = unsignedBigIntToBytes(new Uint8Array(8), 1n << 63n) as ReadonlyUint8Array;
/** menvcfg.ADUE (bit 61) — read-only zero until Svadu is implemented. */
const MENVCFG_ADUE = unsignedBigIntToBytes(new Uint8Array(8), 1n << 61n) as ReadonlyUint8Array;
/** stimecmp slot after reset (all ones). */
const STIMECMP_RESET = unsignedBigIntToBytes(
  new Uint8Array(8),
  0xffff_ffff_ffff_ffffn
) as ReadonlyUint8Array;

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
  writeControlAndStatusRegister(
    registers,
    MIE,
    signedNumberToBytes(new Uint8Array(8), MIE_MTIE, 32)
  );
};
const MHARTID = 0xf14;
const SSTATUS = 0x100;
/** Exception causes used in these tests. */
const CAUSE_ECALL_FROM_U = 8;
const CAUSE_ECALL_FROM_S = 9;
const CAUSE_ECALL_FROM_M = 11;

/** mstatus low fields with hardwired UXL/SXL=64 (byte4 = 0x0a). */
const mstatusBytes = (low32: number): Uint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), BigInt(low32 >>> 0) | (0xan << 32n));
/** Unimplemented CSR address used in illegal-access tests. */
const UNIMPLEMENTED_CSR = 0x400;

describe('system', () => {
  it('ecall traps to mtvec with cause 11 and does not advance pc past the ecall', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x08, 32)
    );

    ecall(registers, guest, FOUR_BYTES);

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x40, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ECALL_FROM_M, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
    // MPIE set, MIE clear, MPP = M → 0x1880.
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0x1880));
  });

  it('ebreak traps to mtvec with cause 3', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );

    ebreak(registers, guest, FOUR_BYTES);

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_BREAKPOINT, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
  });

  it('mret returns to mepc, restores MIE from MPIE, and drops to MPP', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    writeControlAndStatusRegister(
      registers,
      MEPC,
      signedNumberToBytes(new Uint8Array(8), 0x44, 32)
    );
    // MPIE set, MPP = M.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x1880, 32)
    );

    mret(registers, guest, FOUR_BYTES);

    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x44);
    // MIE set, MPIE set, MPP = U → 0x0088.
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0x0088));
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_MACHINE);
  });

  it('mret is illegal outside M-mode', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    mret(registers, testMemory(256n), FOUR_BYTES);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
  });

  it('wfi advances the PC and returns once an interrupt is pending and enabled in mie', async () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    armTimerWake(registers, memory);
    await wfi(registers, memory, FOUR_BYTES);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x84);
  });

  it('wfi retires minstret/mcycle before waiting', async () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    armTimerWake(registers, memory);
    beginInstructionRetire(registers);
    await wfi(registers, memory, FOUR_BYTES);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x84);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCYCLE),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MINSTRET),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    // Run-loop style second commit must not double-count.
    commitInstructionRetire(registers);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCYCLE),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MINSTRET),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
  });

  it('wfi in S-mode with mstatus.TW set raises illegal-instruction', async () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    // TW = bit 21 → 0x20_0000
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x20_0000, 32)
    );
    await wfi(registers, testMemory(256n), FOUR_BYTES);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      unsignedNumberToBytes(new Uint8Array(8), 0x10500073)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_MACHINE);
  });

  it('wfi in M-mode ignores mstatus.TW', async () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x20_0000, 32)
    );
    armTimerWake(registers, memory);
    await wfi(registers, memory, FOUR_BYTES);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x84);
  });

  it('sret returns to sepc and restores SIE from SPIE', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      SEPC,
      signedNumberToBytes(new Uint8Array(8), 0x88, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x120, 32)
    );
    sret(registers, testMemory(256n), FOUR_BYTES);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x88);
    // SIE set, SPIE set, SPP cleared → 0x22 (SPP was set → return to S).
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_SUPERVISOR);
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0x22));
  });

  it('ecall from U and S use causes 8 and 9', () => {
    const registers = createRegisters();
    const guest = testMemory(256n);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );

    setPrivilegeMode(registers, PRIVILEGE_USER);
    ecall(registers, guest, FOUR_BYTES);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ECALL_FROM_U, 32)
    );

    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x10, 32));
    ecall(registers, guest, FOUR_BYTES);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ECALL_FROM_S, 32)
    );
  });

  it('sstatus reads and writes the supervisor view of mstatus', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x188a, 32)
    );
    // SIE + hardwired UXL=64 (SXL is M-only and masked out of sstatus).
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SSTATUS),
      unsignedBigIntToBytes(new Uint8Array(8), 0x02n | (0x2n << 32n))
    );
    writeControlAndStatusRegister(
      registers,
      SSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x20, 32)
    );
    // SIE cleared, SPIE set; MIE/MPIE/MPP preserved → 0x18a8.
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0x18a8));
  });

  it('CSR access from U to an M-mode CSR is illegal', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_USER);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    csrrs(
      registers,
      testMemory(256n),
      {
        destinationRegister: 1,
        sourceRegister1: 0,
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0x300020f3,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
  });

  it('csrrw swaps the CSR into rd and advances pc', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x11, 32)
    );
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(new Uint8Array(8), 0x22, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), mstatusBytes(0x11));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0x22));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('csrrw with rd = rs1 uses the old rs1 as the CSR write', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x11, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0x22, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 1,
        sourceRegister1: 1,
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), mstatusBytes(0x11));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0x22));
  });

  it('csrrw with rd = x0 still updates the CSR', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0x22, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 0,
        sourceRegister1: 1,
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 0)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0x22));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('csrrs sets bits and csrrc clears bits', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0b1100, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0b1010, 32));

    csrrs(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 2), mstatusBytes(0b1100));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0b1110));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);

    csrrc(
      registers,
      testMemory(256n),
      {
        destinationRegister: 3,
        sourceRegister1: 1,
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 3), mstatusBytes(0b1110));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0b0100));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 8);
  });

  it('csrrs and csrrc with rs1 = x0 do not write the CSR', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );

    csrrs(
      registers,
      testMemory(256n),
      {
        destinationRegister: 1,
        sourceRegister1: 0,
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), mstatusBytes(0x5));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0x5));

    csrrc(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 0,
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 2), mstatusBytes(0x5));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0x5));
  });

  it('csrrwi, csrrsi, and csrrci use a zero-extended immediate', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0b1100, 32)
    );

    csrrwi(
      registers,
      testMemory(256n),
      {
        destinationRegister: 1,
        immediate: signedNumberToBytes(new Uint8Array(8), 0b1010, 32),
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), mstatusBytes(0b1100));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0b1010));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);

    csrrsi(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0b0101, 32),
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 2), mstatusBytes(0b1010));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0b1111));

    csrrci(
      registers,
      testMemory(256n),
      {
        destinationRegister: 3,
        immediate: signedNumberToBytes(new Uint8Array(8), 0b0011, 32),
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 3), mstatusBytes(0b1111));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0b1100));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 12);
  });

  it('csrrsi and csrrci with a zero immediate do not write the CSR', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x5, 32)
    );

    csrrsi(
      registers,
      testMemory(256n),
      {
        destinationRegister: 1,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), mstatusBytes(0x5));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0x5));

    csrrci(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        immediate: signedNumberToBytes(new Uint8Array(8), 0, 32),
        controlAndStatusRegister: MSTATUS,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 2), mstatusBytes(0x5));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSTATUS), mstatusBytes(0x5));
  });

  it('csrrw to an identity CSR raises illegal-instruction', () => {
    const registers = createRegisters();
    const instructionWord = 0xf14011f3;
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 99, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: MHARTID,
        instructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      instructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
    assert.deepEqual(
      [...snapshotControlAndStatusRegister(registers, MHARTID)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 2)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
  });

  it('csrrs with rs1 = x0 may read an identity CSR', () => {
    const registers = createRegisters();
    csrrs(
      registers,
      testMemory(256n),
      {
        destinationRegister: 1,
        sourceRegister1: 0,
        controlAndStatusRegister: MHARTID,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 1),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('access to an unimplemented CSR raises illegal-instruction', () => {
    const registers = createRegisters();
    const instructionWord = 0x400020f3;
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x20, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x3000, 32)
    );
    csrrs(
      registers,
      testMemory(256n),
      {
        destinationRegister: 1,
        sourceRegister1: 0,
        controlAndStatusRegister: UNIMPLEMENTED_CSR,
        instructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      instructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x3000);
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 1)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
  });

  it('csrrw reads hardwired misa and WARL-ignores writes', () => {
    const registers = createRegisters();
    const hardwired = snapshotControlAndStatusRegister(registers, MISA);
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0xffff, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: MISA,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 2), hardwired);
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MISA), hardwired);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('csrrw can clear satp from M-mode (OpenSBI path)', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      SATP,
      unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000_0000_0001n)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: SATP,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SATP),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('satp from U-mode raises illegal-instruction', () => {
    const registers = createRegisters();
    const instructionWord = 0x180010f3;
    setPrivilegeMode(registers, PRIVILEGE_USER);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      SATP,
      signedNumberToBytes(new Uint8Array(8), 0x55, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: SATP,
        instructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      instructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SATP),
      signedNumberToBytes(new Uint8Array(8), 0x55, 32)
    );
  });

  it('satp from S-mode with mstatus.TVM set raises illegal-instruction', () => {
    const registers = createRegisters();
    const instructionWord = 0x180010f3;
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    // TVM = bit 20 → 0x10_0000
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x10_0000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      SATP,
      signedNumberToBytes(new Uint8Array(8), 0x55, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: SATP,
        instructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      instructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SATP),
      signedNumberToBytes(new Uint8Array(8), 0x55, 32)
    );
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 2)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
  });

  it('satp from M-mode with mstatus.TVM set still succeeds', () => {
    const registers = createRegisters();
    // TVM = bit 20 → 0x10_0000
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x10_0000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      SATP,
      signedNumberToBytes(new Uint8Array(8), 0x55, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: SATP,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 0x55, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SATP),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('csrrw can read and write mscratch and sscratch at sufficient privilege', () => {
    const registers = createRegisters();
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 0x55aa, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: MSCRATCH,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSCRATCH),
      signedNumberToBytes(new Uint8Array(8), 0x55aa, 32)
    );

    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeGeneralPurposeRegister(registers, 3, signedNumberToBytes(new Uint8Array(8), 0x1234, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 4,
        sourceRegister1: 3,
        controlAndStatusRegister: SSCRATCH,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 4),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SSCRATCH),
      signedNumberToBytes(new Uint8Array(8), 0x1234, 32)
    );
  });

  it('mscratch from S-mode and sscratch from U-mode raise illegal-instruction', () => {
    const registers = createRegisters();
    const mscratchInstructionWord = 0x340010f3;
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSCRATCH,
      signedNumberToBytes(new Uint8Array(8), 0x99, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 1, 32));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: MSCRATCH,
        instructionWord: mscratchInstructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      mscratchInstructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSCRATCH),
      signedNumberToBytes(new Uint8Array(8), 0x99, 32)
    );
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 2)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );

    const sscratchInstructionWord = 0x140010f3;
    setPrivilegeMode(registers, PRIVILEGE_USER);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      SSCRATCH,
      signedNumberToBytes(new Uint8Array(8), 0x77, 32)
    );
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 3,
        sourceRegister1: 1,
        controlAndStatusRegister: SSCRATCH,
        instructionWord: sscratchInstructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      sscratchInstructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SSCRATCH),
      signedNumberToBytes(new Uint8Array(8), 0x77, 32)
    );
  });

  it('sret in M-mode with mstatus.TSR set remains legal', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      SEPC,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    // TSR = bit 22 → 0x40_0000; SPP = U, SPIE set.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x40_0020, 32)
    );

    sret(registers, testMemory(256n), FOUR_BYTES);

    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x80);
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_USER);
  });

  it('sret in S-mode with mstatus.TSR set raises illegal-instruction', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      SEPC,
      signedNumberToBytes(new Uint8Array(8), 0x90, 32)
    );
    // TSR set; SPP = U, SPIE set.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x40_0020, 32)
    );

    sret(registers, testMemory(256n), FOUR_BYTES);

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      unsignedNumberToBytes(new Uint8Array(8), 0x10200073)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
    // sepc unchanged — sret did not complete.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SEPC),
      signedNumberToBytes(new Uint8Array(8), 0x90, 32)
    );
  });

  it('M-mode can read time from CLINT mtime; cycle/instret count retires', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    const seeded = 12_345n;
    storeBytes({
      memory,
      address: CLINT_MTIME,
      source: unsignedBigIntToBytes(new Uint8Array(8), seeded),
      byteLength: 8,
    });

    beginInstructionRetire(registers);
    csrrs(
      registers,
      memory,
      {
        destinationRegister: 1,
        sourceRegister1: 0,
        controlAndStatusRegister: TIME,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    commitInstructionRetire(registers);
    const timeValue = bytesToBigInt(readGeneralPurposeRegister(registers, 1));
    assert.ok(timeValue >= seeded);
    assert.ok(timeValue < seeded + 1_000_000n);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, CYCLE),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, INSTRET),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );

    beginInstructionRetire(registers);
    csrrs(
      registers,
      memory,
      {
        destinationRegister: 2,
        sourceRegister1: 0,
        controlAndStatusRegister: CYCLE,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    commitInstructionRetire(registers);
    // `csrr` sees the pre-retire value; then this instruction bumps both counters.
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCYCLE),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MINSTRET),
      signedNumberToBytes(new Uint8Array(8), 2, 32)
    );
  });

  it('writes to time and cycle raise illegal-instruction', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    const timeInstructionWord = 0xc0101073; // csrrw x0, time, x1
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(new Uint8Array(8), 1, 32));

    csrrw(
      registers,
      memory,
      {
        destinationRegister: 0,
        sourceRegister1: 1,
        controlAndStatusRegister: TIME,
        instructionWord: timeInstructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      timeInstructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);

    const cycleInstructionWord = 0xc0001073; // csrrw x0, cycle, x1
    setPrivilegeMode(registers, PRIVILEGE_MACHINE);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    csrrw(
      registers,
      memory,
      {
        destinationRegister: 0,
        sourceRegister1: 1,
        controlAndStatusRegister: CYCLE,
        instructionWord: cycleInstructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      cycleInstructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x2000);
  });

  it('mcounteren gates S-mode time/cycle; M-mode ignores the enable bits', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    storeBytes({
      memory,
      address: CLINT_MTIME,
      source: unsignedBigIntToBytes(new Uint8Array(8), 50n),
      byteLength: 8,
    });
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );

    // M can read time with mcounteren clear.
    writeControlAndStatusRegister(
      registers,
      MCOUNTEREN,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    csrrs(
      registers,
      memory,
      {
        destinationRegister: 1,
        sourceRegister1: 0,
        controlAndStatusRegister: TIME,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.ok(bytesToBigInt(readGeneralPurposeRegister(registers, 1)) >= 50n);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);

    // S without TM traps.
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    const timeInstructionWord = 0xc01025f3; // csrrs x11, time, x0
    csrrs(
      registers,
      memory,
      {
        destinationRegister: 11,
        sourceRegister1: 0,
        controlAndStatusRegister: TIME,
        instructionWord: timeInstructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      timeInstructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);

    // S with TM succeeds.
    setPrivilegeMode(registers, PRIVILEGE_MACHINE);
    writeControlAndStatusRegister(
      registers,
      MCOUNTEREN,
      signedNumberToBytes(new Uint8Array(8), 0x02, 32)
    );
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    csrrs(
      registers,
      memory,
      {
        destinationRegister: 2,
        sourceRegister1: 0,
        controlAndStatusRegister: TIME,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.ok(bytesToBigInt(readGeneralPurposeRegister(registers, 2)) >= 50n);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x84);

    // S without CY traps on cycle.
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0xc0, 32));
    const cycleInstructionWord = 0xc00025f3; // csrrs x11, cycle, x0
    csrrs(
      registers,
      memory,
      {
        destinationRegister: 11,
        sourceRegister1: 0,
        controlAndStatusRegister: CYCLE,
        instructionWord: cycleInstructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      cycleInstructionWord
    );
  });

  it('U-mode time needs both mcounteren.TM and scounteren.TM', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    storeBytes({
      memory,
      address: CLINT_MTIME,
      source: unsignedBigIntToBytes(new Uint8Array(8), 77n),
      byteLength: 8,
    });
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MCOUNTEREN,
      signedNumberToBytes(new Uint8Array(8), 0x02, 32)
    );
    writeControlAndStatusRegister(
      registers,
      SCOUNTEREN,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );

    setPrivilegeMode(registers, PRIVILEGE_USER);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    const timeInstructionWord = 0xc01025f3;
    csrrs(
      registers,
      memory,
      {
        destinationRegister: 11,
        sourceRegister1: 0,
        controlAndStatusRegister: TIME,
        instructionWord: timeInstructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      timeInstructionWord
    );

    setPrivilegeMode(registers, PRIVILEGE_MACHINE);
    writeControlAndStatusRegister(
      registers,
      SCOUNTEREN,
      signedNumberToBytes(new Uint8Array(8), 0x02, 32)
    );
    setPrivilegeMode(registers, PRIVILEGE_USER);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    csrrs(
      registers,
      memory,
      {
        destinationRegister: 3,
        sourceRegister1: 0,
        controlAndStatusRegister: TIME,
        instructionWord: 0,
      },
      FOUR_BYTES
    );
    assert.ok(bytesToBigInt(readGeneralPurposeRegister(registers, 3)) >= 77n);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x84);
  });

  it('illegal CSR access does not retire; ecall does', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );

    beginInstructionRetire(registers);
    csrrw(
      registers,
      memory,
      {
        destinationRegister: 0,
        sourceRegister1: 1,
        controlAndStatusRegister: TIME,
        instructionWord: 0xc0101073,
      },
      FOUR_BYTES
    );
    commitInstructionRetire(registers);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCYCLE),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MINSTRET),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );

    setPrivilegeMode(registers, PRIVILEGE_MACHINE);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    beginInstructionRetire(registers);
    ecall(registers, memory, FOUR_BYTES);
    commitInstructionRetire(registers);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCYCLE),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MINSTRET),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
  });

  /** Pack a 32-bit instruction encoding as little-endian bytes and execute it. */
  const runEncoded = (
    encoding: number,
    registers: ReturnType<typeof createRegisters>,
    memory: ReturnType<typeof testMemory>
  ): void => {
    const bytes = new Uint8Array(4);
    bytes[0] = encoding & 0xff;
    bytes[1] = (encoding >>> 8) & 0xff;
    bytes[2] = (encoding >>> 16) & 0xff;
    bytes[3] = (encoding >>> 24) & 0xff;
    const [execute, instructionByteLength] = decode(bytes);
    const result = execute(registers, memory, instructionByteLength);
    if (result !== undefined) {
      throw new Error('sfence.vma is synchronous');
    }
  };

  it('decodes sfence.vma and advances pc', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    // sfence.vma x0, x0
    runEncoded(0x12000073, registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
    // sfence.vma x1, x2
    runEncoded(0x12208073, registers, memory);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 8);
  });

  it('sfence.vma with rd set raises illegal-instruction', () => {
    const registers = createRegisters();
    const instructionWord = 0x120000f3;
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    runEncoded(instructionWord, registers, testMemory(256n));
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      instructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
  });

  it('sfence.vma in U-mode raises illegal-instruction', () => {
    const registers = createRegisters();
    const instructionWord = 0x12000073;
    setPrivilegeMode(registers, PRIVILEGE_USER);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    sfenceVma(registers, testMemory(256n), { instructionWord }, FOUR_BYTES);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      instructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
  });

  it('sfence.vma in S-mode advances pc', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    sfenceVma(registers, testMemory(256n), { instructionWord: 0x12000073 }, FOUR_BYTES);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x44);
  });

  it('sfence.vma in S-mode with mstatus.TVM set raises illegal-instruction', () => {
    const registers = createRegisters();
    const instructionWord = 0x12208073;
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x10_0000, 32)
    );
    sfenceVma(registers, testMemory(256n), { instructionWord }, FOUR_BYTES);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      instructionWord
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
  });

  it('sfence.vma in M-mode with mstatus.TVM set still advances pc', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_MACHINE);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x10_0000, 32)
    );
    sfenceVma(registers, testMemory(256n), { instructionWord: 0x12000073 }, FOUR_BYTES);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x44);
  });

  it('csrrw from M-mode reaches menvcfg and keeps only STCE', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    // All ones: only the WARL-implemented field survives (STCE 63).
    writeGeneralPurposeRegister(
      registers,
      1,
      unsignedBigIntToBytes(new Uint8Array(8), 0xffff_ffff_ffff_ffffn)
    );

    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: MENVCFG,
        instructionWord: 0x30a09173, // csrrw x2, menvcfg, x1
      },
      FOUR_BYTES
    );

    // rd gets the reset value (0); the CSR takes rs1 through the WARL mask; pc advances by 4.
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MENVCFG), MENVCFG_WARL_KEEP);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x44);

    // FIOM (bit 3) is read-only zero: writing it reads STCE back and stores 0.
    writeGeneralPurposeRegister(registers, 1, unsignedBigIntToBytes(new Uint8Array(8), 1n << 3n));
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: MENVCFG,
        instructionWord: 0x30a09173,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 2), MENVCFG_WARL_KEEP);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MENVCFG),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );

    // ADUE (bit 61) is read-only zero while Svadu is unimplemented: it never sticks.
    writeGeneralPurposeRegister(registers, 1, MENVCFG_ADUE);
    csrrw(
      registers,
      testMemory(256n),
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: MENVCFG,
        instructionWord: 0x30a09173,
      },
      FOUR_BYTES
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 2), new Uint8Array(8));
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MENVCFG),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );
  });

  it('S-mode csrr stimecmp works when menvcfg.STCE and mcounteren.TM are set', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);
    writeControlAndStatusRegister(
      registers,
      MCOUNTEREN,
      signedNumberToBytes(new Uint8Array(8), 0x02, 32)
    );
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    const value = unsignedBigIntToBytes(new Uint8Array(8), 0x1234n);
    writeGeneralPurposeRegister(registers, 2, value);

    csrrw(
      registers,
      memory,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        controlAndStatusRegister: STIMECMP,
        instructionWord: 0x14d110f3, // csrrw x1, stimecmp, x2
      },
      FOUR_BYTES
    );

    // rd gets the reset compare (all ones); the CSR takes rs1; pc advances by 4.
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), STIMECMP_RESET);
    assert.deepEqual(snapshotControlAndStatusRegister(registers, STIMECMP), value);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x44);
  });

  it('S-mode stimecmp traps with illegal-instruction when mcounteren.TM is clear', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    const instructionWord = 0x14d110f3; // csrrw x1, stimecmp, x2
    writeGeneralPurposeRegister(registers, 2, unsignedBigIntToBytes(new Uint8Array(8), 0x1234n));

    csrrw(
      registers,
      memory,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        controlAndStatusRegister: STIMECMP,
        instructionWord,
      },
      FOUR_BYTES
    );

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      instructionWord
    );
    // The trap handler PC replaces the unchanged (unretired) instruction PC.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x40, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
    assert.deepEqual(snapshotControlAndStatusRegister(registers, STIMECMP), STIMECMP_RESET);

    // M-mode with mcounteren.TM clear still succeeds.
    setPrivilegeMode(registers, PRIVILEGE_MACHINE);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    csrrw(
      registers,
      memory,
      {
        destinationRegister: 1,
        sourceRegister1: 2,
        controlAndStatusRegister: STIMECMP,
        instructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, STIMECMP),
      unsignedBigIntToBytes(new Uint8Array(8), 0x1234n)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x84);
  });

  it('M-mode stimecmp works while menvcfg.STCE is clear', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x40, 32));
    const instructionWord = 0x14d090f3; // csrrw x1, stimecmp, x1
    writeGeneralPurposeRegister(registers, 1, unsignedBigIntToBytes(new Uint8Array(8), 0x1234n));

    // Sstc gates the compare below M only: with STCE clear, M-mode reads and writes stay legal.
    csrrw(
      registers,
      memory,
      {
        destinationRegister: 2,
        sourceRegister1: 1,
        controlAndStatusRegister: STIMECMP,
        instructionWord,
      },
      FOUR_BYTES
    );

    assert.deepEqual(readGeneralPurposeRegister(registers, 2), STIMECMP_RESET);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, STIMECMP),
      unsignedBigIntToBytes(new Uint8Array(8), 0x1234n)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x44);
    // No trap was taken, and the compare does not own STIP: it stays software-owned.
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MCAUSE), new Uint8Array(8));
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MIP), new Uint8Array(8));

    // The same access in S-mode still faults while STCE is clear.
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    csrrw(
      registers,
      memory,
      {
        destinationRegister: 1,
        sourceRegister1: 1,
        controlAndStatusRegister: STIMECMP,
        instructionWord,
      },
      FOUR_BYTES
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ILLEGAL_INSTRUCTION, 32)
    );
    assert.equal(
      bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)),
      instructionWord
    );
    // The faulting instruction did not advance past its own pc.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x1000);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, STIMECMP),
      unsignedBigIntToBytes(new Uint8Array(8), 0x1234n)
    );
  });

  // Bounded: a lost notify would park this test forever (node:test has no default timeout), so
  // bound it and let the failure surface as an assertion failure.
  it('wfi in S-mode returns when stimecmp expires', { timeout: 5000 }, async () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);
    // stimecmp just ahead of the reset mtime (0); mie.STIE makes the interrupt count for
    // `wfi`'s pending ∧ enabled check.
    writeControlAndStatusRegister(
      registers,
      STIMECMP,
      unsignedBigIntToBytes(new Uint8Array(8), 1_000n)
    );
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), MIE_STIE, 32)
    );
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));

    const waiting = wfi(registers, memory, FOUR_BYTES);
    // Let the wait install, then prove the hart is still parked: without this the test would pass
    // even if `wfi` returned immediately. The STIP wire is what notifies the parked hart, so the
    // hart must already have published `stimecmp` into the mirror (it does so on the sample pass
    // before it parks).
    await delay(20);
    assert.equal(
      await Promise.race([waiting.then(() => 'woke'), delay(1).then(() => 'waiting')]),
      'waiting'
    );

    // Expire the compare through the CLINT guest window.
    storeBytes({
      memory,
      address: CLINT_MTIME,
      source: unsignedBigIntToBytes(new Uint8Array(8), 1_000n),
      byteLength: 8,
    });
    tickClint(memory);
    await waiting;

    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x84);
    assert.notEqual(snapshotControlAndStatusRegister(registers, MIP)[0]! & 0x20, 0);
  });

  it('disabling menvcfg.STCE drops the supervisor timer wire', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);
    storeBytes({
      memory,
      address: CLINT_MTIME,
      source: unsignedBigIntToBytes(new Uint8Array(8), 10n),
      byteLength: 8,
    });
    writeControlAndStatusRegister(
      registers,
      STIMECMP,
      unsignedBigIntToBytes(new Uint8Array(8), 5n)
    );
    publishSupervisorTimerCompare(registers, memory);
    assert.equal(isClintSupervisorTimerPending(memory), true);

    // STCE clear: the compare does not exist, so the publish parks the mirror at all-ones and a
    // stale `mtime >= stimecmp` result cannot stay on the wire.
    writeControlAndStatusRegister(registers, MENVCFG, new Uint8Array(8));
    publishSupervisorTimerCompare(registers, memory);
    assert.equal(isClintSupervisorTimerPending(memory), false);
    setSupervisorTimerInterruptPending(registers, isClintSupervisorTimerPending(memory));
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );
  });
});
