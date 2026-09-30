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
import {
  MIDELEG,
  MIE,
  MIP,
  MSTATUS,
  PRIVILEGE_MACHINE,
  advanceProgramCounter,
  createRegisters,
  snapshotControlAndStatusRegister,
  readGeneralPurposeRegister,
  readPrivilegeMode,
  readProgramCounter,
  setBooleanGeneralPurposeRegister,
  setMachineExternalInterruptPending,
  setMachineTimerInterruptPending,
  setProgramCounter,
  setSupervisorExternalInterruptPending,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#emulator/cpu/registers';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

const SIE = 0x104;
const SIP = 0x144;

/** mstatus low fields with hardwired UXL/SXL=64 (byte4 = 0x0a). */
const mstatusBytes = (low32: number): Uint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), BigInt(low32 >>> 0) | (0xan << 32n));

describe('registers', () => {
  it('resets in machine mode', () => {
    assert.deepEqual(readPrivilegeMode(createRegisters()), PRIVILEGE_MACHINE);
  });

  it('x0 reads as zero on reset', () => {
    const registers = createRegisters();
    assert.deepEqual(
      [...readGeneralPurposeRegister(registers, 0)],
      [...signedNumberToBytes(new Uint8Array(8), 0, 32)]
    );
  });

  it('writes and reads a general-purpose register', () => {
    const registers = createRegisters();
    const value = signedNumberToBytes(new Uint8Array(8), 42, 32);
    writeGeneralPurposeRegister(registers, 1, value);
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), value);
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
    advanceProgramCounter(registers);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 104);
  });

  it('writes and reads a control-and-status register', () => {
    const registers = createRegisters();
    const value = signedNumberToBytes(new Uint8Array(8), 0x1234, 32);
    writeControlAndStatusRegister(registers, 0x305, value);
    assert.deepEqual(snapshotControlAndStatusRegister(registers, 0x305), value);
  });

  it('x0 ignores writes at runtime', () => {
    const registers = createRegisters();
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

  it('hardwires mstatus.UXL and SXL to 64 on create', () => {
    assert.deepEqual(snapshotControlAndStatusRegister(createRegisters(), MSTATUS), mstatusBytes(0));
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

  it('mepc and sepc WARL clear bits below IALIGN=32', () => {
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
      signedNumberToBytes(new Uint8Array(8), 0x120, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, 0x141),
      signedNumberToBytes(new Uint8Array(8), 0x454, 32)
    );
  });
});
