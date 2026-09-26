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

import { bytesToBigInt } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';
import { setIrqWire } from '#emulator/memory/hart-wake';
import type { Memory } from '#emulator/memory/types';

/**
 * CLINT layout (single hart), relative to `clintBaseAddress`:
 *   msip     @ +0x0000 (4 bytes; only bit 0 is meaningful)
 *   mtimecmp @ +0x4000 (8 bytes)
 *   mtime    @ +0xbff8 (8 bytes)
 * Only those registers are mapped; the intervening physical-address hole is not allocated.
 */
const CLINT_MSIP_OFFSET = 0x0n;
const CLINT_MTIMECMP_OFFSET = 0x4000n;
const CLINT_MTIME_OFFSET = 0xbff8n;
const CLINT_MSIP_SIZE = 4;
const CLINT_REGISTER_SIZE = 8;
/** Byte length of the guest CLINT window `[clintBase, clintBase + size)` (through mtime). */
const CLINT_WINDOW_SIZE = 0xc000n;

/**
 * Host packing after UART in `memory.bytes` (8-byte aligned base; Atomics on u64s/wires):
 *   [mtime 8][mtimecmp 8][timerWire 1][softwareWire 1][pad 6][epochNs 8]
 */
const CLINT_HOST_MTIME_UINT64 = 0;
const CLINT_HOST_MTIMECMP_UINT64 = 1;
const CLINT_HOST_EPOCH_NS_UINT64 = 3;
const CLINT_HOST_UINT64_COUNT = 4;
const CLINT_HOST_SIZE = CLINT_HOST_UINT64_COUNT * 8;
const CLINT_HOST_TIMER_WIRE_OFFSET = 16;
const CLINT_HOST_SOFTWARE_WIRE_OFFSET = 17;

/** Free-running `mtime` frequency (10 MHz timebase). */
const CLINT_TIMEBASE_HZ = 10_000_000n;
const NS_PER_SECOND = 1_000_000_000n;

type ClintTimeRegister = 'mtime' | 'mtimecmp';
type ClintRegister = 'msip' | ClintTimeRegister;

/** Drive a level-sensitive CLINT IRQ wire (1 = pending); wake `wfi` only on 0→1. */
const setClintIrqWire = (memory: Memory, wireOffset: number, pending: boolean): void => {
  setIrqWire(memory, memory.clintHostBaseIndex + wireOffset, pending);
};

/** Drive the level-sensitive CLINT timer IRQ wire (1 = pending). */
const setClintTimerWire = (memory: Memory, pending: boolean): void => {
  setClintIrqWire(memory, CLINT_HOST_TIMER_WIRE_OFFSET, pending);
};

/** Level of the CLINT timer interrupt wire (sampled by the hart into `mip.MTIP`). */
const isClintMachineTimerPending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, memory.clintHostBaseIndex + CLINT_HOST_TIMER_WIRE_OFFSET) !== 0;

/** Drive the level-sensitive CLINT software IRQ wire (1 = pending). */
const setClintSoftwareWire = (memory: Memory, pending: boolean): void => {
  setClintIrqWire(memory, CLINT_HOST_SOFTWARE_WIRE_OFFSET, pending);
};

/** Level of the CLINT software interrupt wire (sampled by the hart into `mip.MSIP`). */
const isClintMachineSoftwarePending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, memory.clintHostBaseIndex + CLINT_HOST_SOFTWARE_WIRE_OFFSET) !== 0;

const clintAddressToRegister = (
  memory: Memory,
  address: ReadonlyUint8Array
): { register: ClintRegister; byteOffset: number } | null => {
  const guestAddress = bytesToBigInt(address);
  const clintBase = bytesToBigInt(memory.clintBaseAddress);
  const msipBase = clintBase + CLINT_MSIP_OFFSET;
  if (guestAddress >= msipBase && guestAddress < msipBase + BigInt(CLINT_MSIP_SIZE)) {
    return { register: 'msip', byteOffset: Number(guestAddress - msipBase) };
  }
  const mtimeBase = clintBase + CLINT_MTIME_OFFSET;
  if (guestAddress >= mtimeBase && guestAddress < mtimeBase + BigInt(CLINT_REGISTER_SIZE)) {
    return { register: 'mtime', byteOffset: Number(guestAddress - mtimeBase) };
  }
  const mtimecmpBase = clintBase + CLINT_MTIMECMP_OFFSET;
  if (guestAddress >= mtimecmpBase && guestAddress < mtimecmpBase + BigInt(CLINT_REGISTER_SIZE)) {
    return { register: 'mtimecmp', byteOffset: Number(guestAddress - mtimecmpBase) };
  }
  return null;
};

/** `BigUint64Array` over the CLINT host region (`mtime` / `mtimecmp` / pad / `epochNs`). */
const clintHostUint64s = (memory: Memory): BigUint64Array =>
  new BigUint64Array(memory.bytes.buffer, memory.clintHostBaseIndex, CLINT_HOST_UINT64_COUNT);

const timeRegisterUint64Index = (register: ClintTimeRegister): number =>
  register === 'mtime' ? CLINT_HOST_MTIME_UINT64 : CLINT_HOST_MTIMECMP_UINT64;

const timeRegisterByteIndex = (
  memory: Memory,
  register: ClintTimeRegister,
  byteOffset: number
): number => memory.clintHostBaseIndex + timeRegisterUint64Index(register) * 8 + byteOffset;

const loadTimeRegisterByte = (
  memory: Memory,
  register: ClintTimeRegister,
  byteOffset: number
): number => Atomics.load(memory.bytes, timeRegisterByteIndex(memory, register, byteOffset));

const storeTimeRegisterByte = (
  memory: Memory,
  register: ClintTimeRegister,
  byteOffset: number,
  value: number
): void => {
  Atomics.store(memory.bytes, timeRegisterByteIndex(memory, register, byteOffset), value & 0xff);
};

/** Guest msip byte: only byte 0 bit 0 is defined (software IRQ wire). */
const loadMsipByte = (memory: Memory, byteOffset: number): number => {
  if (byteOffset !== 0) {
    return 0;
  }
  return isClintMachineSoftwarePending(memory) ? 1 : 0;
};

const storeMsipByte = (memory: Memory, byteOffset: number, value: number): void => {
  if (byteOffset !== 0) {
    return;
  }
  setClintSoftwareWire(memory, (value & 1) !== 0);
};

const readTimeRegister = (memory: Memory, register: ClintTimeRegister): bigint =>
  Atomics.load(clintHostUint64s(memory), timeRegisterUint64Index(register));

const writeTimeRegister = (memory: Memory, register: ClintTimeRegister, value: bigint): void => {
  Atomics.store(
    clintHostUint64s(memory),
    timeRegisterUint64Index(register),
    BigInt.asUintN(64, value)
  );
};

const writeEpochNs = (memory: Memory, value: bigint): void => {
  Atomics.store(clintHostUint64s(memory), CLINT_HOST_EPOCH_NS_UINT64, BigInt.asUintN(64, value));
};

const readEpochNs = (memory: Memory): bigint =>
  Atomics.load(clintHostUint64s(memory), CLINT_HOST_EPOCH_NS_UINT64);

const updateTimerWireFromCompare = (memory: Memory): void => {
  setClintTimerWire(
    memory,
    readTimeRegister(memory, 'mtime') >= readTimeRegister(memory, 'mtimecmp')
  );
};

const reseatEpochFromMtime = (memory: Memory): void => {
  const mtime = readTimeRegister(memory, 'mtime');
  writeEpochNs(memory, process.hrtime.bigint() - (mtime * NS_PER_SECOND) / CLINT_TIMEBASE_HZ);
};

/** Initialize CLINT shadows: mtime = 0, mtimecmp = all-ones, wires clear. */
const initializeClint = (memory: Memory): void => {
  writeTimeRegister(memory, 'mtime', 0n);
  writeTimeRegister(memory, 'mtimecmp', 0xffff_ffff_ffff_ffffn);
  writeEpochNs(memory, process.hrtime.bigint());
  setClintTimerWire(memory, false);
  setClintSoftwareWire(memory, false);
};

/**
 * Advance free-running `mtime` from the host clock and refresh the timer IRQ wire.
 * Called by the CLINT timebase worker (host packing only; not a guest load/store).
 */
const tickClint = (memory: Memory): void => {
  const elapsedNs = process.hrtime.bigint() - readEpochNs(memory);
  const ticks = (elapsedNs * CLINT_TIMEBASE_HZ) / NS_PER_SECOND;
  writeTimeRegister(memory, 'mtime', ticks);
  updateTimerWireFromCompare(memory);
};

const loadClintByte = (memory: Memory, register: ClintRegister, byteOffset: number): number => {
  switch (register) {
    case 'msip':
      return loadMsipByte(memory, byteOffset);
    case 'mtime':
    case 'mtimecmp':
      return loadTimeRegisterByte(memory, register, byteOffset);
  }
};

const storeClintByte = (
  memory: Memory,
  register: ClintRegister,
  byteOffset: number,
  value: number
): void => {
  switch (register) {
    case 'msip':
      storeMsipByte(memory, byteOffset, value);
      return;
    case 'mtime':
      storeTimeRegisterByte(memory, register, byteOffset, value);
      reseatEpochFromMtime(memory);
      updateTimerWireFromCompare(memory);
      return;
    case 'mtimecmp':
      storeTimeRegisterByte(memory, register, byteOffset, value);
      updateTimerWireFromCompare(memory);
      return;
  }
};

export {
  CLINT_HOST_SIZE,
  CLINT_WINDOW_SIZE,
  tickClint,
  clintAddressToRegister,
  initializeClint,
  isClintMachineSoftwarePending,
  isClintMachineTimerPending,
  loadClintByte,
  storeClintByte,
};
