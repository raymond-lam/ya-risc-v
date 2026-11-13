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
import { isClintSupervisorTimerPending } from '#emulator/clint';
import {
  MEDELEG,
  MIDELEG,
  MIE,
  MIP,
  MSTATUS,
  MTVEC,
  PRIVILEGE_MACHINE,
  PRIVILEGE_SUPERVISOR,
  PRIVILEGE_USER,
  STVEC,
  advanceProgramCounter,
  beginInstructionRetire,
  commitInstructionRetire,
  createRegisters,
  isControlAndStatusRegisterAccessAllowed,
  menvcfgAdueIsEnabled,
  satpRootTablePhysicalAddress,
  satpTranslationIsActive,
  snapshotControlAndStatusRegister,
  readGeneralPurposeRegister,
  readPrivilegeMode,
  readProgramCounter,
  setBooleanGeneralPurposeRegister,
  setMachineExternalInterruptPending,
  setMachineTimerInterruptPending,
  publishSupervisorTimerCompare,
  setPrivilegeMode,
  setProgramCounter,
  setSupervisorExternalInterruptPending,
  setSupervisorTimerInterruptPending,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
  FOUR_BYTES,
} from '#emulator/cpu/registers';
import { storeBytes } from '#emulator/memory';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';

/** CSR addresses used only in these tests (not part of the registers public surface). */
const MISA = 0x301;
const MSCRATCH = 0x340;
const SSCRATCH = 0x140;
const SATP = 0x180;
const MCOUNTEREN = 0x306;
const SCOUNTEREN = 0x106;
const MCOUNTINHIBIT = 0x320;
const MCYCLE = 0xb00;
const MINSTRET = 0xb02;
const CYCLE = 0xc00;
const MENVCFG = 0x30a;
const STIMECMP = 0x14d;

/** menvcfg.STCE (bit 63). */
const MENVCFG_STCE = unsignedBigIntToBytes(new Uint8Array(8), 1n << 63n) as ReadonlyUint8Array;
/** menvcfg WARL keeps STCE (63) and ADUE (61) only. */
const MENVCFG_WARL_KEEP = unsignedBigIntToBytes(
  new Uint8Array(8),
  (1n << 63n) | (1n << 61n)
) as ReadonlyUint8Array;
/** mip/sip.STIP (bit 5). */
const STIP = 1 << 5;
/** CLINT `mtime` guest address (test map). */
const CLINT_MTIME = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_bff8n) as ReadonlyUint8Array;

/** Seed CLINT `mtime` with a fixed value (no timebase worker runs in unit tests). */
const seedClintMtime = async (
  memory: ReturnType<typeof testMemory>,
  mtime: bigint
): Promise<void> => {
  await storeBytes({
    memory,
    address: CLINT_MTIME,
    source: unsignedBigIntToBytes(new Uint8Array(8), mtime),
    byteLength: 8,
  });
};

/** Publish the hart's `stimecmp` into the CLINT mirror, then sample the STIP wire into `mip`. */
const publishAndSampleSupervisorTimer = (
  registers: ReturnType<typeof createRegisters>,
  memory: ReturnType<typeof testMemory>
): void => {
  publishSupervisorTimerCompare(registers, memory);
  setSupervisorTimerInterruptPending(registers, isClintSupervisorTimerPending(memory));
};

/** Hardwired misa: MXL=64 and extensions A, C, I, M, S, U. */
const MISA_HARDWIRED = unsignedBigIntToBytes(
  new Uint8Array(8),
  (2n << 62n) | (1n << 20n) | (1n << 18n) | (1n << 12n) | (1n << 8n) | (1n << 2n) | (1n << 0n)
);

const SIE = 0x104;
const SIP = 0x144;

/** mstatus low fields with hardwired UXL/SXL=64 (byte4 = 0x0a). */
const mstatusBytes = (low32: number): Uint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), BigInt(low32 >>> 0) | (0xan << 32n));

describe('registers', () => {
  it('resets in machine mode', () => {
    assert.deepEqual(readPrivilegeMode(createRegisters()), PRIVILEGE_MACHINE);
  });

  it('setBooleanGeneralPurposeRegister writes 0 or 1', () => {
    const registers = createRegisters();
    setBooleanGeneralPurposeRegister(registers, 2, true);
    setBooleanGeneralPurposeRegister(registers, 3, false);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 2),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 3),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
  });

  it('setProgramCounter and advanceProgramCounter update pc by 4', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 100, 32));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 100);
    advanceProgramCounter(registers, FOUR_BYTES);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 104);
  });

  it('mtvec and stvec WARL force reserved MODE to Direct', () => {
    const registers = createRegisters();
    // MODE=2 (reserved) → forced to Direct (0); BASE preserved → 0x1234.
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x1236, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVEC),
      signedNumberToBytes(new Uint8Array(8), 0x1234, 32)
    );
    // MODE=3 (reserved) → Direct; Vectored (1) sticks.
    writeControlAndStatusRegister(
      registers,
      STVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2003, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, STVEC),
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      STVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2001, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, STVEC),
      signedNumberToBytes(new Uint8Array(8), 0x2001, 32)
    );
  });

  it('medeleg WARL keeps bit 11 (M-mode ecall) read-only zero', () => {
    const registers = createRegisters();
    // Set many exception bits including bit 11 (0x800).
    writeControlAndStatusRegister(
      registers,
      MEDELEG,
      signedNumberToBytes(new Uint8Array(8), 0xffff, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MEDELEG),
      signedNumberToBytes(new Uint8Array(8), 0xf7ff, 32)
    );
  });

  it('misa is hardwired RV64IMAC+S/U and WARL-ignores writes', () => {
    const registers = createRegisters();
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MISA), MISA_HARDWIRED);
    writeControlAndStatusRegister(
      registers,
      MISA,
      signedNumberToBytes(new Uint8Array(8), 0xffff, 32)
    );
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MISA), MISA_HARDWIRED);
  });

  it('satp resets to zero', () => {
    const registers = createRegisters();
    assert.deepEqual(snapshotControlAndStatusRegister(registers, SATP), new Uint8Array(8));
  });

  it('satp MODE=Bare (0) and MODE=Sv39 (8) round-trip; bad MODE ignored', () => {
    const registers = createRegisters();

    // MODE=Bare: all-zero SATP is legal.
    assert.deepEqual(snapshotControlAndStatusRegister(registers, SATP), new Uint8Array(8));
    // MODE=0, ASID=0x1234, PPN=0x5678 → full 64-bit value has PPN in bits [43:0].
    writeControlAndStatusRegister(
      registers,
      SATP,
      unsignedBigIntToBytes(new Uint8Array(8), 0x0000_1234_5678n)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SATP),
      unsignedBigIntToBytes(new Uint8Array(8), 0x0000_1234_5678n)
    );
    assert.ok(!satpTranslationIsActive(registers));
    // PPN is the full lower 44 bits = 0x12345678, PA = PPN << 12 = 0x12345678000.
    assert.deepEqual(
      satpRootTablePhysicalAddress(registers),
      unsignedBigIntToBytes(new Uint8Array(8), 0x12345678000n)
    );

    // MODE=Sv39: write with ASID=0 so PPN = full lower 44 bits cleanly.
    // MODE=8 (byte7=0x80), PPN=0x5678.
    const sv39 = unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000_0000_5678n);
    writeControlAndStatusRegister(registers, SATP, sv39);
    assert.deepEqual(snapshotControlAndStatusRegister(registers, SATP), sv39);
    assert.ok(satpTranslationIsActive(registers));
    // PPN = lower 44 bits = 0x5678, PA = PPN << 12 = 0x5678000.
    assert.deepEqual(
      satpRootTablePhysicalAddress(registers),
      unsignedBigIntToBytes(new Uint8Array(8), 0x5678000n)
    );

    // Bad MODE (9): entire write ignored.
    const before = snapshotControlAndStatusRegister(registers, SATP);
    const badValue = unsignedBigIntToBytes(new Uint8Array(8), 0x9000_0000_0000_5678n);
    const result = writeControlAndStatusRegister(registers, SATP, badValue);
    assert.deepEqual(result, before);
    assert.deepEqual(snapshotControlAndStatusRegister(registers, SATP), before);

    // MODE 1–7 all rejected from reset state.
    writeControlAndStatusRegister(registers, SATP, new Uint8Array(8));
    for (let mode = 1; mode <= 7; mode++) {
      const bad = unsignedBigIntToBytes(new Uint8Array(8), BigInt(mode) << 60n);
      writeControlAndStatusRegister(registers, SATP, bad);
      assert.deepEqual(
        snapshotControlAndStatusRegister(registers, SATP),
        new Uint8Array(8),
        `MODE=${mode} should be rejected`
      );
    }
  });

  it('satpRootTablePhysicalAddress returns PPN<<12', () => {
    const registers = createRegisters();
    // PPN = 0x123, PA = 0x123000.
    writeControlAndStatusRegister(
      registers,
      SATP,
      unsignedBigIntToBytes(new Uint8Array(8), 0x0000_0000_0000_0123n)
    );
    const pa = satpRootTablePhysicalAddress(registers);
    const paExpected = unsignedBigIntToBytes(new Uint8Array(8), 0x123000n);
    assert.deepEqual(pa, paExpected);
    assert.equal(pa[0], 0); // low 12 bits zero
  });

  it('mscratch and sscratch reset to zero and hold XLEND writes', () => {
    const registers = createRegisters();
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSCRATCH),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SSCRATCH),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );

    const mValue = signedNumberToBytes(new Uint8Array(8), 0x1111_2222, 32);
    const sValue = unsignedBigIntToBytes(new Uint8Array(8), 0x8899_aabb_ccdd_eeffn);
    writeControlAndStatusRegister(registers, MSCRATCH, mValue);
    writeControlAndStatusRegister(registers, SSCRATCH, sValue);
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MSCRATCH), mValue);
    assert.deepEqual(snapshotControlAndStatusRegister(registers, SSCRATCH), sValue);

    // Scratch slots are independent.
    writeControlAndStatusRegister(
      registers,
      MSCRATCH,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.deepEqual(snapshotControlAndStatusRegister(registers, SSCRATCH), sValue);
  });

  it('x0 ignores writes at runtime', () => {
    const registers = createRegisters();
    // Reads zero on reset, and the ignored write leaves it zero.
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 0)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
    writeGeneralPurposeRegister(registers, 0, signedNumberToBytes(new Uint8Array(8), 99, 32));
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 0)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
  });

  it('identity CSR helper ignores writes (guest path traps before write)', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(registers, 0xf14, signedNumberToBytes(new Uint8Array(8), 99, 32));
    assert.deepEqual(
      [...snapshotControlAndStatusRegister(registers, 0xf14)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
  });

  it('mstatus WARL forces reserved MPP to U and hardwires UXL/SXL to 64', () => {
    // Fresh create: UXL/SXL hardwired to 64 (byte4 = 0x0a), everything else zero.
    assert.deepEqual(snapshotControlAndStatusRegister(createRegisters(), MSTATUS), mstatusBytes(0));
    const registers = createRegisters();
    // bits 12:11 = 10 (reserved)
    writeControlAndStatusRegister(
      registers,
      0x300,
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    assert.deepEqual(snapshotControlAndStatusRegister(registers, 0x300), mstatusBytes(0));
  });

  it('mie WARL keeps implemented enables; mip CSR writes leave MSIP/MTIP alone', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), 0xffff, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIP,
      signedNumberToBytes(new Uint8Array(8), 0xffff, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIE),
      signedNumberToBytes(new Uint8Array(8), 0x0aaa, 32)
    );
    // Writable pending bits (SSIP/STIP/SEIP); no MSIP/MTIP/MEIP from CSR.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      signedNumberToBytes(new Uint8Array(8), 0x0222, 32)
    );

    setMachineTimerInterruptPending(registers, true);
    writeControlAndStatusRegister(registers, MIP, signedNumberToBytes(new Uint8Array(8), 0, 32));
    // MTIP survives a software clear of mip.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
  });

  it('mideleg WARL keeps only supervisor interrupt causes', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MIDELEG,
      signedNumberToBytes(new Uint8Array(8), 0xffff, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIDELEG),
      signedNumberToBytes(new Uint8Array(8), 0x0222, 32)
    );
  });

  it('mcounteren and scounteren WARL keep only CY, TM, and IR', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MCOUNTEREN,
      signedNumberToBytes(new Uint8Array(8), 0xffff, 32)
    );
    writeControlAndStatusRegister(
      registers,
      SCOUNTEREN,
      signedNumberToBytes(new Uint8Array(8), 0xffff, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCOUNTEREN),
      signedNumberToBytes(new Uint8Array(8), 0x07, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SCOUNTEREN),
      signedNumberToBytes(new Uint8Array(8), 0x07, 32)
    );
  });

  it('mcountinhibit WARL keeps only CY and IR; freezes retire bumps', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MCOUNTINHIBIT,
      signedNumberToBytes(new Uint8Array(8), 0xffff, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCOUNTINHIBIT),
      signedNumberToBytes(new Uint8Array(8), 0x05, 32)
    );

    beginInstructionRetire(registers);
    commitInstructionRetire(registers);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCYCLE),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MINSTRET),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );

    writeControlAndStatusRegister(
      registers,
      MCOUNTINHIBIT,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    beginInstructionRetire(registers);
    commitInstructionRetire(registers);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCYCLE),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, CYCLE),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
  });

  it('mcountinhibit.CY alone freezes mcycle but not minstret (IR alone the reverse)', () => {
    const registers = createRegisters();

    writeControlAndStatusRegister(
      registers,
      MCOUNTINHIBIT,
      signedNumberToBytes(new Uint8Array(8), 0x1, 32)
    );
    beginInstructionRetire(registers);
    commitInstructionRetire(registers);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCYCLE),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MINSTRET),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );

    writeControlAndStatusRegister(
      registers,
      MCOUNTINHIBIT,
      signedNumberToBytes(new Uint8Array(8), 0x4, 32)
    );
    beginInstructionRetire(registers);
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

  it('mcycle is writable from M and aliases cycle; cycle writes are ignored by the helper', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MCYCLE,
      signedNumberToBytes(new Uint8Array(8), 99, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, CYCLE),
      signedNumberToBytes(new Uint8Array(8), 99, 32)
    );
    writeControlAndStatusRegister(registers, CYCLE, signedNumberToBytes(new Uint8Array(8), 1, 32));
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCYCLE),
      signedNumberToBytes(new Uint8Array(8), 99, 32)
    );
  });

  it('sie/sip are masked views of mie/mip', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), 0x0aaa, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIP,
      signedNumberToBytes(new Uint8Array(8), 0x0022, 32)
    );
    setSupervisorExternalInterruptPending(registers, true);
    setMachineExternalInterruptPending(registers, true);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SIE),
      signedNumberToBytes(new Uint8Array(8), 0x0222, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SIP),
      signedNumberToBytes(new Uint8Array(8), 0x0222, 32)
    );

    writeControlAndStatusRegister(registers, SIE, signedNumberToBytes(new Uint8Array(8), 0, 32));
    // M bits preserved; S bits cleared.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIE),
      signedNumberToBytes(new Uint8Array(8), 0x0888, 32)
    );

    writeControlAndStatusRegister(
      registers,
      SIP,
      signedNumberToBytes(new Uint8Array(8), 1 << 5, 32)
    );
    // STIP via sip; SSIP cleared; SEIP/MEIP (PLIC) preserved.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      signedNumberToBytes(new Uint8Array(8), 0x0a20, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SIP),
      signedNumberToBytes(new Uint8Array(8), 0x0220, 32)
    );
  });

  it('mip.SEIP is soft OR PLIC; CSR writes update only the soft bit', () => {
    const registers = createRegisters();
    // Soft SEIP via mip write.
    writeControlAndStatusRegister(
      registers,
      MIP,
      signedNumberToBytes(new Uint8Array(8), 1 << 9, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      signedNumberToBytes(new Uint8Array(8), 0x0200, 32)
    );

    // PLIC wire alone also shows as SEIP.
    writeControlAndStatusRegister(registers, MIP, signedNumberToBytes(new Uint8Array(8), 0, 32));
    setSupervisorExternalInterruptPending(registers, true);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      signedNumberToBytes(new Uint8Array(8), 0x0200, 32)
    );

    // Soft + PLIC; clearing PLIC leaves soft SEIP.
    writeControlAndStatusRegister(
      registers,
      MIP,
      signedNumberToBytes(new Uint8Array(8), 1 << 9, 32)
    );
    setSupervisorExternalInterruptPending(registers, false);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      signedNumberToBytes(new Uint8Array(8), 0x0200, 32)
    );

    // sip cannot clear soft SEIP.
    writeControlAndStatusRegister(registers, SIP, signedNumberToBytes(new Uint8Array(8), 0, 32));
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      signedNumberToBytes(new Uint8Array(8), 0x0200, 32)
    );
  });

  it('mepc and sepc WARL clear bits below IALIGN=16', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      0x341,
      signedNumberToBytes(new Uint8Array(8), 0x123, 32)
    );
    writeControlAndStatusRegister(
      registers,
      0x141,
      signedNumberToBytes(new Uint8Array(8), 0x456, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x341),
      signedNumberToBytes(new Uint8Array(8), 0x122, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x141),
      signedNumberToBytes(new Uint8Array(8), 0x456, 32)
    );
  });

  it('menvcfg WARL keeps only STCE and ADUE', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MENVCFG,
      unsignedBigIntToBytes(new Uint8Array(8), 0xffff_ffff_ffff_ffffn)
    );
    const result = snapshotControlAndStatusRegister(registers, MENVCFG);
    assert.deepEqual(result, MENVCFG_WARL_KEEP);
    assert.equal(result[7], 0xa0); // STCE | ADUE

    // menvcfg is an M-mode CSR (address bits [9:8] = 11): S-mode access is illegal.
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    assert.equal(isControlAndStatusRegisterAccessAllowed(registers, MENVCFG, false), false);
  });

  it('menvcfg ADUE is writable and readable', () => {
    const registers = createRegisters();
    assert.ok(!menvcfgAdueIsEnabled(registers));

    // Set ADUE (bit 61).
    writeControlAndStatusRegister(
      registers,
      MENVCFG,
      unsignedBigIntToBytes(new Uint8Array(8), 1n << 61n)
    );
    assert.ok(menvcfgAdueIsEnabled(registers));

    // Clear ADUE.
    writeControlAndStatusRegister(registers, MENVCFG, new Uint8Array(8));
    assert.ok(!menvcfgAdueIsEnabled(registers));
  });

  it('menvcfg STCE and ADUE can coexist', () => {
    const registers = createRegisters();
    const both = unsignedBigIntToBytes(new Uint8Array(8), (1n << 63n) | (1n << 61n));
    writeControlAndStatusRegister(registers, MENVCFG, both);

    const menvcfg = snapshotControlAndStatusRegister(registers, MENVCFG);
    assert.equal(menvcfg[7], 0xa0); // STCE | ADUE
    assert.ok(menvcfgAdueIsEnabled(registers));

    // Non-writable bits masked out.
    const mixed = unsignedBigIntToBytes(new Uint8Array(8), (1n << 63n) | (1n << 61n) | 1n);
    writeControlAndStatusRegister(registers, MENVCFG, mixed);
    const after = snapshotControlAndStatusRegister(registers, MENVCFG);
    assert.deepEqual(after, MENVCFG_WARL_KEEP);
  });

  it('M-mode stimecmp is legal while menvcfg.STCE is clear', async () => {
    const registers = createRegisters();
    const memory = testMemory(256n);

    // Sstc gates the compare below M only: M-mode reads and writes work with STCE clear.
    assert.equal(isControlAndStatusRegisterAccessAllowed(registers, STIMECMP, false), true);
    assert.equal(isControlAndStatusRegisterAccessAllowed(registers, STIMECMP, true), true);
    writeControlAndStatusRegister(
      registers,
      STIMECMP,
      unsignedBigIntToBytes(new Uint8Array(8), 0x1234n)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, STIMECMP),
      unsignedBigIntToBytes(new Uint8Array(8), 0x1234n)
    );

    // STIP stays software-owned: publishing the compare must not drive it from the mirror.
    await seedClintMtime(memory, 0x2000n);
    publishAndSampleSupervisorTimer(registers, memory);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );

    // Below M the same access faults while STCE is clear.
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    assert.equal(isControlAndStatusRegisterAccessAllowed(registers, STIMECMP, false), false);
    setPrivilegeMode(registers, PRIVILEGE_USER);
    assert.equal(isControlAndStatusRegisterAccessAllowed(registers, STIMECMP, false), false);

    // With STCE set, S-mode succeeds (mcounteren.TM permitting).
    setPrivilegeMode(registers, PRIVILEGE_MACHINE);
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);
    assert.equal(isControlAndStatusRegisterAccessAllowed(registers, STIMECMP, false), true);
  });

  it('S-mode stimecmp needs mcounteren.TM but M-mode does not', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);

    writeControlAndStatusRegister(
      registers,
      MCOUNTEREN,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.equal(isControlAndStatusRegisterAccessAllowed(registers, STIMECMP, false), false);

    writeControlAndStatusRegister(
      registers,
      MCOUNTEREN,
      signedNumberToBytes(new Uint8Array(8), 0x02, 32)
    );
    assert.equal(isControlAndStatusRegisterAccessAllowed(registers, STIMECMP, false), true);

    // M-mode ignores the counter-enable bits.
    setPrivilegeMode(registers, PRIVILEGE_MACHINE);
    writeControlAndStatusRegister(
      registers,
      MCOUNTEREN,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    assert.equal(isControlAndStatusRegisterAccessAllowed(registers, STIMECMP, false), true);
  });

  it('stimecmp compare sets and clears mip.STIP', async () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);
    await seedClintMtime(memory, 500n);

    writeControlAndStatusRegister(
      registers,
      STIMECMP,
      unsignedBigIntToBytes(new Uint8Array(8), 500n)
    );
    publishAndSampleSupervisorTimer(registers, memory);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), BigInt(STIP))
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SIP),
      unsignedBigIntToBytes(new Uint8Array(8), BigInt(STIP))
    );

    // Writing a compare above `mtime` clears the pending bit (the publish updates the wire at
    // once, so this does not wait for a timebase tick).
    writeControlAndStatusRegister(
      registers,
      STIMECMP,
      unsignedBigIntToBytes(new Uint8Array(8), 501n)
    );
    publishAndSampleSupervisorTimer(registers, memory);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );
  });

  it('reset stimecmp does not assert STIP', () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);

    // The CSR and the CLINT mirror both reset all-ones, so `mtime >= stimecmp` is false.
    publishSupervisorTimerCompare(registers, memory);
    assert.equal(isClintSupervisorTimerPending(memory), false);
    setSupervisorTimerInterruptPending(registers, false);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );
  });

  it('setSupervisorTimerInterruptPending sets and clears mip.STIP', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);

    setSupervisorTimerInterruptPending(registers, true);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), BigInt(STIP))
    );

    setSupervisorTimerInterruptPending(registers, false);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );

    // With STCE clear, STIP is software-owned: the wire sample must not touch it.
    const software = createRegisters();
    writeControlAndStatusRegister(
      software,
      MIP,
      unsignedBigIntToBytes(new Uint8Array(8), BigInt(STIP))
    );
    setSupervisorTimerInterruptPending(software, false);
    assert.deepEqual(
      snapshotControlAndStatusRegister(software, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), BigInt(STIP))
    );
  });

  it('mip and sip STIP are read-only while menvcfg.STCE is set', async () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);
    await seedClintMtime(memory, 10n);
    writeControlAndStatusRegister(
      registers,
      STIMECMP,
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );
    publishAndSampleSupervisorTimer(registers, memory);

    // CSR writes cannot clear the hardware-owned bit, through mip or sip.
    writeControlAndStatusRegister(registers, MIP, new Uint8Array(8));
    writeControlAndStatusRegister(registers, SIP, new Uint8Array(8));
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), BigInt(STIP))
    );

    // With STCE clear, STIP is software-writable again.
    writeControlAndStatusRegister(registers, MENVCFG, new Uint8Array(8));
    writeControlAndStatusRegister(registers, MIP, new Uint8Array(8));
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );
  });

  it('mip and sip STIP writes are dropped while the compare is not pending', async () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);
    await seedClintMtime(memory, 10n);
    // Compare above `mtime`: STIP is not pending, so a surviving write would be visible.
    writeControlAndStatusRegister(
      registers,
      STIMECMP,
      unsignedBigIntToBytes(new Uint8Array(8), 11n)
    );
    publishAndSampleSupervisorTimer(registers, memory);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );

    // SSIP is software-writable, STIP is not: the same write keeps only SSIP.
    const stipAndSsip = unsignedBigIntToBytes(new Uint8Array(8), BigInt(STIP) | 0b10n);
    writeControlAndStatusRegister(registers, MIP, stipAndSsip);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0b10n)
    );
    writeControlAndStatusRegister(registers, MIP, new Uint8Array(8));
    writeControlAndStatusRegister(registers, SIP, stipAndSsip);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0b10n)
    );
  });

  it('clearing menvcfg.STCE clears a hardware STIP', async () => {
    const registers = createRegisters();
    const memory = testMemory(256n);
    writeControlAndStatusRegister(registers, MENVCFG, MENVCFG_STCE);
    await seedClintMtime(memory, 10n);
    writeControlAndStatusRegister(
      registers,
      STIMECMP,
      unsignedBigIntToBytes(new Uint8Array(8), 5n)
    );
    publishAndSampleSupervisorTimer(registers, memory);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), BigInt(STIP))
    );

    // The compare owns STIP only while STCE is set; dropping STCE must not leave it set.
    writeControlAndStatusRegister(registers, MENVCFG, new Uint8Array(8));
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );
    // Disabling STCE publishes all-ones, so the wire drops and the compare cannot re-assert it.
    publishAndSampleSupervisorTimer(registers, memory);
    assert.equal(isClintSupervisorTimerPending(memory), false);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MIP),
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );
  });
});
