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
import { wfi } from '#emulator/cpu/instructions/system';
import {
  MCAUSE,
  MIDELEG,
  MIE,
  MSTATUS,
  MTVEC,
  PRIVILEGE_SUPERVISOR,
  SCAUSE,
  STVEC,
  createRegisters,
  readProgramCounter,
  setPrivilegeMode,
  setProgramCounter,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  FOUR_BYTES,
} from '#emulator/cpu/registers';
import sampleDevicePending from '#emulator/cpu/sample-device-pending';
import { takeInterruptIfAny } from '#emulator/cpu/trap';
import { isClintMachineSoftwarePending, isClintMachineTimerPending } from '#emulator/clint';
import {
  IRQ_LEVEL_MEIP,
  IRQ_LEVEL_MSIP,
  IRQ_LEVEL_SEIP,
  loadIrqLevel,
  waitIrqLevel,
} from '#emulator/irq-level';
import { storeBytes } from '#emulator/memory';
import {
  isPlicMachineExternalPending,
  isPlicSupervisorExternalPending,
  PLIC_SOURCE_UART,
  setPlicSourcePending,
} from '#emulator/plic';
import createTestMemory from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

/** Interrupt codes (mcause/scause with interrupt bit set). */
const CAUSE_MACHINE_SOFTWARE_INTERRUPT = 3;
const CAUSE_MACHINE_TIMER_INTERRUPT = 7;
const CAUSE_SUPERVISOR_EXTERNAL_INTERRUPT = 9;
const CAUSE_MACHINE_EXTERNAL_INTERRUPT = 11;

/** mie / sie enable bits (bit index = cause). */
const MIE_MSIE = 1 << CAUSE_MACHINE_SOFTWARE_INTERRUPT;
const MIE_MTIE = 1 << CAUSE_MACHINE_TIMER_INTERRUPT;
const MIE_SEIE = 1 << CAUSE_SUPERVISOR_EXTERNAL_INTERRUPT;
const MIE_MEIE = 1 << CAUSE_MACHINE_EXTERNAL_INTERRUPT;

/** mstatus.MIE / SIE */
const MSTATUS_SIE = 0x02;
const MSTATUS_MIE = 0x08;

/** mideleg bit for supervisor external interrupt. */
const MIDELEG_SEI = 1 << CAUSE_SUPERVISOR_EXTERNAL_INTERRUPT;

const CLINT_MSIP = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_0000n) as ReadonlyUint8Array;
const CLINT_MTIMECMP = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_4000n) as ReadonlyUint8Array;
const CLINT_MTIME = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_bff8n) as ReadonlyUint8Array;

const interruptCauseBytes = (code: number): Uint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), (1n << 63n) | BigInt(code));

const plicStore = (
  memory: ReturnType<typeof createTestMemory>,
  offset: bigint,
  value: number
): void => {
  storeBytes({
    memory,
    address: unsignedBigIntToBytes(new Uint8Array(8), 0x0c00_0000n + offset),
    source: unsignedBigIntToBytes(new Uint8Array(8), BigInt(value >>> 0)),
    byteLength: 4,
  });
};

/** Priority > 0, S-context enable for UART, threshold 0 — leaves MEIP clear. */
const enablePlicSupervisorUart = (memory: ReturnType<typeof createTestMemory>): void => {
  plicStore(memory, BigInt(PLIC_SOURCE_UART * 4), 1);
  plicStore(memory, 0x2080n, 1 << PLIC_SOURCE_UART);
  plicStore(memory, 0x201000n, 0);
};

/** Priority > 0, M-context enable for UART, threshold 0. */
const enablePlicMachineUart = (memory: ReturnType<typeof createTestMemory>): void => {
  plicStore(memory, BigInt(PLIC_SOURCE_UART * 4), 1);
  plicStore(memory, 0x2000n, 1 << PLIC_SOURCE_UART);
  plicStore(memory, 0x200000n, 0);
};

describe('device wire → mip → takeInterruptIfAny', () => {
  it('takes a machine software interrupt after CLINT msip asserts', () => {
    const registers = createRegisters();
    const memory = createTestMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x1000, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x4000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), MSTATUS_MIE, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), MIE_MSIE, 32)
    );

    storeBytes({
      memory,
      address: CLINT_MSIP,
      source: new Uint8Array([1, 0, 0, 0]),
      byteLength: 4,
    });
    assert.equal(isClintMachineSoftwarePending(memory), true);

    sampleDevicePending(registers, memory);
    assert.equal(takeInterruptIfAny(registers), true);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      interruptCauseBytes(CAUSE_MACHINE_SOFTWARE_INTERRUPT)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x4000);
  });

  it('takes a machine timer interrupt after mtime catches mtimecmp', () => {
    const registers = createRegisters();
    const memory = createTestMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x1000, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x4000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), MSTATUS_MIE, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), MIE_MTIE, 32)
    );

    storeBytes({
      memory,
      address: CLINT_MTIMECMP,
      source: unsignedBigIntToBytes(new Uint8Array(8), 1n),
      byteLength: 8,
    });
    storeBytes({
      memory,
      address: CLINT_MTIME,
      source: unsignedBigIntToBytes(new Uint8Array(8), 1n),
      byteLength: 8,
    });
    assert.equal(isClintMachineTimerPending(memory), true);

    sampleDevicePending(registers, memory);
    assert.equal(takeInterruptIfAny(registers), true);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      interruptCauseBytes(CAUSE_MACHINE_TIMER_INTERRUPT)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x4000);
  });

  it('takes a machine external interrupt after PLIC UART pending is enabled', () => {
    const registers = createRegisters();
    const memory = createTestMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x1000, 32));
    writeControlAndStatusRegister(
      registers,
      MTVEC,
      signedNumberToBytes(new Uint8Array(8), 0x4000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), MSTATUS_MIE, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), MIE_MEIE, 32)
    );

    enablePlicMachineUart(memory);
    setPlicSourcePending(memory, PLIC_SOURCE_UART, true);
    assert.equal(isPlicMachineExternalPending(memory), true);

    sampleDevicePending(registers, memory);
    assert.equal(takeInterruptIfAny(registers), true);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, MCAUSE),
      interruptCauseBytes(CAUSE_MACHINE_EXTERNAL_INTERRUPT)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x4000);
  });

  it('takes a supervisor external interrupt after PLIC S-context UART via mideleg', () => {
    const registers = createRegisters();
    const memory = createTestMemory(256n);
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x1000, 32));
    writeControlAndStatusRegister(
      registers,
      STVEC,
      signedNumberToBytes(new Uint8Array(8), 0x5000, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIDELEG,
      signedNumberToBytes(new Uint8Array(8), MIDELEG_SEI, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MSTATUS,
      signedNumberToBytes(new Uint8Array(8), MSTATUS_SIE, 32)
    );
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), MIE_SEIE, 32)
    );

    // S-context only — enabling M as well would assert MEIP and take MEI first in S.
    enablePlicSupervisorUart(memory);
    setPlicSourcePending(memory, PLIC_SOURCE_UART, true);
    assert.equal(isPlicSupervisorExternalPending(memory), true);
    assert.equal(isPlicMachineExternalPending(memory), false);

    sampleDevicePending(registers, memory);
    assert.equal(takeInterruptIfAny(registers), true);
    assert.deepEqual(
      snapshotControlAndStatusRegister(registers, SCAUSE),
      interruptCauseBytes(CAUSE_SUPERVISOR_EXTERNAL_INTERRUPT)
    );
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x5000);
  });
});

describe('wfi irq-level notify', () => {
  it('waitIrqLevel resolves when CLINT msip publishes a level change', async () => {
    const memory = createTestMemory(256n);
    const fromLevel = loadIrqLevel(memory);
    assert.equal(fromLevel & IRQ_LEVEL_MSIP, 0);

    const waiting = waitIrqLevel(memory, fromLevel);
    await delay(20);
    storeBytes({
      memory,
      address: CLINT_MSIP,
      source: new Uint8Array([1, 0, 0, 0]),
      byteLength: 4,
    });
    await waiting;
    assert.equal(loadIrqLevel(memory) & IRQ_LEVEL_MSIP, IRQ_LEVEL_MSIP);
  });

  it('wfi resumes after a deferred CLINT msip assert notifies the wake word', async () => {
    const registers = createRegisters();
    const memory = createTestMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), MIE_MSIE, 32)
    );

    const done = wfi(registers, memory, FOUR_BYTES);
    await delay(20);
    storeBytes({
      memory,
      address: CLINT_MSIP,
      source: new Uint8Array([1, 0, 0, 0]),
      byteLength: 4,
    });
    await done;
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x84);
  });

  it('wfi resumes after a deferred PLIC MEIP assert notifies the wake word', async () => {
    const registers = createRegisters();
    const memory = createTestMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), MIE_MEIE, 32)
    );
    enablePlicMachineUart(memory);
    assert.equal(loadIrqLevel(memory) & IRQ_LEVEL_MEIP, 0);

    const done = wfi(registers, memory, FOUR_BYTES);
    await delay(20);
    setPlicSourcePending(memory, PLIC_SOURCE_UART, true);
    await done;
    assert.equal(loadIrqLevel(memory) & IRQ_LEVEL_MEIP, IRQ_LEVEL_MEIP);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x84);
  });

  it('wfi resumes after a deferred PLIC SEIP assert notifies the wake word', async () => {
    const registers = createRegisters();
    const memory = createTestMemory(256n);
    setProgramCounter(registers, signedNumberToBytes(new Uint8Array(8), 0x80, 32));
    writeControlAndStatusRegister(
      registers,
      MIE,
      signedNumberToBytes(new Uint8Array(8), MIE_SEIE, 32)
    );
    enablePlicSupervisorUart(memory);
    assert.equal(loadIrqLevel(memory) & IRQ_LEVEL_SEIP, 0);

    const done = wfi(registers, memory, FOUR_BYTES);
    await delay(20);
    setPlicSourcePending(memory, PLIC_SOURCE_UART, true);
    await done;
    assert.equal(loadIrqLevel(memory) & IRQ_LEVEL_SEIP, IRQ_LEVEL_SEIP);
    assert.equal(bytesToNumber(readProgramCounter(registers)), 0x84);
  });
});
