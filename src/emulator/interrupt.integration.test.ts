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
  MIE,
  MSTATUS,
  MTVEC,
  createRegisters,
  readProgramCounter,
  setMachineExternalInterruptPending,
  setMachineSoftwareInterruptPending,
  setMachineTimerInterruptPending,
  setProgramCounter,
  setSupervisorExternalInterruptPending,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
} from '#emulator/cpu/registers';
import { takeInterruptIfAny } from '#emulator/cpu/trap';
import {
  isClintMachineSoftwarePending,
  isClintMachineTimerPending,
  isPlicMachineExternalPending,
  isPlicSupervisorExternalPending,
  loadHartIrqLevel,
  storeBytes,
  waitHartWake,
  type Memory,
} from '#emulator/memory';
import { PLIC_SOURCE_UART, setPlicSourcePending } from '#emulator/memory/plic';
import createTestMemory from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { bytesToNumber, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

/** Interrupt codes (mcause with interrupt bit set). */
const CAUSE_MACHINE_SOFTWARE_INTERRUPT = 3;
const CAUSE_MACHINE_TIMER_INTERRUPT = 7;
const CAUSE_MACHINE_EXTERNAL_INTERRUPT = 11;

/** mie enable bits (bit index = cause). */
const MIE_MSIE = 1 << CAUSE_MACHINE_SOFTWARE_INTERRUPT;
const MIE_MTIE = 1 << CAUSE_MACHINE_TIMER_INTERRUPT;
const MIE_MEIE = 1 << CAUSE_MACHINE_EXTERNAL_INTERRUPT;

/** mstatus.MIE */
const MSTATUS_MIE = 0x08;

const CLINT_MSIP = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_0000n) as ReadonlyUint8Array;
const CLINT_MTIMECMP = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_4000n) as ReadonlyUint8Array;
const CLINT_MTIME = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_bff8n) as ReadonlyUint8Array;

/** Hart-wake MSIP level bit (matches `hart-wake.ts`). */
const IRQ_LEVEL_MSIP = 1 << 3;

const interruptCauseBytes = (code: number): Uint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), (1n << 63n) | BigInt(code));

/** Sample device wires into `mip` the same way the hart run loop does. */
const sampleDevicePending = (
  registers: ReturnType<typeof createRegisters>,
  memory: Memory
): void => {
  setMachineTimerInterruptPending(registers, isClintMachineTimerPending(memory));
  setMachineSoftwareInterruptPending(registers, isClintMachineSoftwarePending(memory));
  setMachineExternalInterruptPending(registers, isPlicMachineExternalPending(memory));
  setSupervisorExternalInterruptPending(registers, isPlicSupervisorExternalPending(memory));
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

    // Priority > 0, M-context enable for UART source 10, threshold 0, then assert pending.
    const plicStore = (offset: bigint, value: number): void => {
      storeBytes({
        memory,
        address: unsignedBigIntToBytes(new Uint8Array(8), 0x0c00_0000n + offset),
        source: unsignedBigIntToBytes(new Uint8Array(8), BigInt(value >>> 0)),
        byteLength: 4,
      });
    };
    plicStore(BigInt(PLIC_SOURCE_UART * 4), 1);
    plicStore(0x2000n, 1 << PLIC_SOURCE_UART);
    plicStore(0x200000n, 0);
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
});

describe('wfi hart-wake notify', () => {
  it('waitHartWake resolves when CLINT msip publishes a level change', async () => {
    const memory = createTestMemory(256n);
    const fromLevel = loadHartIrqLevel(memory);
    assert.equal(fromLevel & IRQ_LEVEL_MSIP, 0);

    const waiting = waitHartWake(memory, fromLevel);
    await delay(20);
    storeBytes({
      memory,
      address: CLINT_MSIP,
      source: new Uint8Array([1, 0, 0, 0]),
      byteLength: 4,
    });
    await waiting;
    assert.equal(loadHartIrqLevel(memory) & IRQ_LEVEL_MSIP, IRQ_LEVEL_MSIP);
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

    const done = wfi(registers, memory);
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
});
