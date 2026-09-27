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
  CAUSE_BREAKPOINT,
  CAUSE_ILLEGAL_INSTRUCTION,
  enterTrap,
  instructionWordTrapValue,
  isPendingEnabledInterrupt,
  returnFromMachineTrap,
  returnFromSupervisorTrap,
  takeInterruptIfAny,
} from '#emulator/cpu/trap';
import {
  MCAUSE,
  MEDELEG,
  MEPC,
  MIDELEG,
  MIE,
  MIP,
  MSTATUS,
  MTVAL,
  MTVEC,
  PRIVILEGE_MACHINE,
  PRIVILEGE_SUPERVISOR,
  PRIVILEGE_USER,
  SCAUSE,
  SEPC,
  STVEC,
  createRegisters,
  snapshotControlAndStatusRegister,
  readPrivilegeMode,
  readProgramCounter,
  setMachineExternalInterruptPending,
  setMachineSoftwareInterruptPending,
  setMachineTimerInterruptPending,
  setPrivilegeMode,
  setProgramCounter,
  writeControlAndStatusRegister,
} from '#emulator/cpu/registers';
import {
  bytesToNumber,
  signedNumberToBytes,
  unsignedBigIntToBytes,
  unsignedNumberToBytes,
} from '#utils/bytes';

/** Exception causes used in these tests (not exported — production uses locals in trap.ts). */
const CAUSE_ECALL_FROM_U = 8;
const CAUSE_ECALL_FROM_M = 11;
const CAUSE_SUPERVISOR_TIMER_INTERRUPT = 5;
const CAUSE_MACHINE_SOFTWARE_INTERRUPT = 3;
const CAUSE_MACHINE_TIMER_INTERRUPT = 7;

const interruptCauseBytes = (code: number): Uint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), (1n << 63n) | BigInt(code));

describe('trap', () => {
  it('enterTrap saves mepc/mcause/mtval, updates mstatus, and jumps to mtvec', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x100, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x2001, 32)
    );
    // MIE set so MPIE should become 1 after entry.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x08, 32)
    );

    enterTrap(registers, CAUSE_ECALL_FROM_M);

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x100, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ECALL_FROM_M, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    // MPIE set, MIE clear, MPP = M → 0x1880.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x1880, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_MACHINE);
    // Direct mode: low 2 bits of mtvec cleared.
    assert.deepEqual(
      readProgramCounter(registers),
      signedNumberToBytes(new Uint8Array(8), 0x2000, 32)
    );
  });

  it('enterTrap records MPP from the prior privilege mode', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x400, 32)
    );

    enterTrap(registers, CAUSE_BREAKPOINT);

    // MPIE clear, MIE clear, MPP = S → 0x0800.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x0800, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_MACHINE);
  });

  it('enterTrap clears MPIE when MIE was clear', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x400, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );

    enterTrap(registers, CAUSE_BREAKPOINT);

    // MPIE clear, MIE clear, MPP = M → 0x1800.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x1800, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_BREAKPOINT, 32)
    );
  });

  it('enterTrap records a zero-extended instruction word in mtval', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x800, 32)
    );
    const word = 0xdead_beef;

    enterTrap(registers, CAUSE_ILLEGAL_INSTRUCTION, instructionWordTrapValue(word));

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      unsignedNumberToBytes(new Uint8Array(8), word)
    );
    assert.equal(bytesToNumber(snapshotControlAndStatusRegister(registers, MTVAL)), word);
  });

  it('enterTrap delegates to S when medeleg allows and privilege is below M', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_USER);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x50, 32));
    writeControlAndStatusRegister(
      registers,
      MEDELEG,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_ECALL_FROM_U, 32)
    );
    writeControlAndStatusRegister(
      registers,
      STVEC,
      signedNumberToBytes(new Uint8Array(8), 0x3000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x02, 32)
    );

    enterTrap(registers, CAUSE_ECALL_FROM_U);

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SEPC),
      signedNumberToBytes(new Uint8Array(8), 0x50, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SCAUSE),
      signedNumberToBytes(new Uint8Array(8), CAUSE_ECALL_FROM_U, 32)
    );
    // SPIE set, SIE clear, SPP = U → 0x20.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x20, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_SUPERVISOR);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x3000);
  });

  it('takeInterruptIfAny takes a machine software interrupt when MSIP/MSIE/MIE are set', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x1000, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x4000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x08, 32)
    );
    setMachineSoftwareInterruptPending(registers, true);
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_MACHINE_SOFTWARE_INTERRUPT, 32)
    );

    assert.equal(takeInterruptIfAny(registers), true);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      interruptCauseBytes(CAUSE_MACHINE_SOFTWARE_INTERRUPT)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x4000);
  });

  it('isPendingEnabledInterrupt ignores global MIE', () => {
    const registers = createRegisters();
    // mstatus.MIE clear
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    setMachineTimerInterruptPending(registers, true);
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_MACHINE_TIMER_INTERRUPT, 32)
    );
    assert.equal(isPendingEnabledInterrupt(registers), true);
    assert.equal(takeInterruptIfAny(registers), false);
  });

  it('isPendingEnabledInterrupt is false when mie masks the pending bit', () => {
    const registers = createRegisters();
    setMachineTimerInterruptPending(registers, true);
    writeControlAndStatusRegister(registers, MIE, signedNumberToBytes(new Uint8Array(8), 0, 32));
    assert.equal(isPendingEnabledInterrupt(registers), false);
  });

  it('takeInterruptIfAny takes a machine timer interrupt when MTIP/MTIE/MIE are set', () => {
    const registers = createRegisters();
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x1000, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x4000, 32)
    );
    // mstatus.MIE
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x08, 32)
    );
    // mip.MTIP from CLINT path; mie.MTIE (bit 7)
    setMachineTimerInterruptPending(registers, true);
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_MACHINE_TIMER_INTERRUPT, 32)
    );

    assert.equal(takeInterruptIfAny(registers), true);

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MEPC),
      signedNumberToBytes(new Uint8Array(8), 0x1000, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      interruptCauseBytes(CAUSE_MACHINE_TIMER_INTERRUPT)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MTVAL),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
    // MPIE set, MIE clear, MPP = M → 0x1880.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x1880, 32)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x4000);
  });

  it('takeInterruptIfAny returns false when MIE is clear in M-mode', () => {
    const registers = createRegisters();
    setMachineTimerInterruptPending(registers, true);
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_MACHINE_TIMER_INTERRUPT, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );

    assert.equal(takeInterruptIfAny(registers), false);
  });

  it('takeInterruptIfAny takes a machine interrupt in S-mode without MIE', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x200, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x5000, 32)
    );
    setMachineTimerInterruptPending(registers, true);
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_MACHINE_TIMER_INTERRUPT, 32)
    );
    // MIE clear — still taken because privilege < M.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );

    assert.equal(takeInterruptIfAny(registers), true);
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_MACHINE);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x5000);
    // MPP = S → 0x0800.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x0800, 32)
    );
  });

  it('takeInterruptIfAny delegates a supervisor timer interrupt via mideleg', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_USER);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      MIDELEG,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );
    writeControlAndStatusRegister(
      registers,
      STVEC,
      signedNumberToBytes(new Uint8Array(8), 0x6000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIP,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );

    assert.equal(takeInterruptIfAny(registers), true);

    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SEPC),
      signedNumberToBytes(new Uint8Array(8), 0x80, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SCAUSE),
      interruptCauseBytes(CAUSE_SUPERVISOR_TIMER_INTERRUPT)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_SUPERVISOR);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x6000);
    // SPIE clear (SIE was clear in U), SIE clear, SPP = U → 0.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );
  });

  it('takeInterruptIfAny takes a delegated STIP in S-mode when SIE is set', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x90, 32));
    writeControlAndStatusRegister(
      registers,
      MIDELEG,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );
    writeControlAndStatusRegister(
      registers,
      STVEC,
      signedNumberToBytes(new Uint8Array(8), 0x6100, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIP,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );
    // mstatus.SIE
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x02, 32)
    );

    assert.equal(takeInterruptIfAny(registers), true);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SEPC),
      signedNumberToBytes(new Uint8Array(8), 0x90, 32)
    );
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SCAUSE),
      interruptCauseBytes(CAUSE_SUPERVISOR_TIMER_INTERRUPT)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_SUPERVISOR);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x6100);
    // SPIE set, SIE clear, SPP = S → 0x120.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x120, 32)
    );
  });

  it('takeInterruptIfAny ignores a delegated STIP in S-mode when SIE is clear', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      MIDELEG,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIP,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );

    assert.equal(takeInterruptIfAny(registers), false);
  });

  it('takeInterruptIfAny ignores a mideleg-delegated interrupt while in M-mode', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MIDELEG,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIP,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), 1 << CAUSE_SUPERVISOR_TIMER_INTERRUPT, 32)
    );
    // MIE set — still must not take a delegated supervisor interrupt in M.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x08, 32)
    );

    assert.equal(takeInterruptIfAny(registers), false);
  });

  it('takeInterruptIfAny prefers MEI over MTI when both are pending', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x7000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x08, 32)
    );
    // MTIP (CLINT) + MEIP (PLIC); MTIE|MEIE
    setMachineTimerInterruptPending(registers, true);
    setMachineExternalInterruptPending(registers, true);
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), (1 << 7) | (1 << 11), 32)
    );

    assert.equal(takeInterruptIfAny(registers), true);
    assert.deepEqual(snapshotControlAndStatusRegister(registers, MCAUSE), interruptCauseBytes(11));
  });

  it('returnFromMachineTrap restores MIE from MPIE, privilege from MPP, and sets MPP to U', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MEPC,
      signedNumberToBytes(new Uint8Array(8), 0x120, 32)
    );
    // MPIE set, MIE clear, MPP = S.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x0880, 32)
    );

    returnFromMachineTrap(registers);

    // MIE set, MPIE set, MPP = U → 0x0088.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x0088, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_SUPERVISOR);
    assert.deepEqual(
      readProgramCounter(registers),
      signedNumberToBytes(new Uint8Array(8), 0x120, 32)
    );
  });

  it('returnFromMachineTrap leaves MIE clear when MPIE was clear', () => {
    const registers = createRegisters();
    writeControlAndStatusRegister(
      registers,
      MEPC,
      signedNumberToBytes(new Uint8Array(8), 0x40, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0, 32)
    );

    returnFromMachineTrap(registers);

    // MIE clear, MPIE set, MPP = U → 0x0080.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x0080, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_USER);
  });

  it('returnFromSupervisorTrap restores SIE from SPIE and privilege from SPP', () => {
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      SEPC,
      signedNumberToBytes(new Uint8Array(8), 0x60, 32)
    );
    // SPIE set, SIE clear, SPP = U.
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), 0x20, 32)
    );

    returnFromSupervisorTrap(registers);

    // SIE set, SPIE set, SPP = U → 0x22.
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MSTATUS),
      signedNumberToBytes(new Uint8Array(8), 0x22, 32)
    );
    assert.deepEqual(readPrivilegeMode(registers), PRIVILEGE_USER);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x60);
  });
});
