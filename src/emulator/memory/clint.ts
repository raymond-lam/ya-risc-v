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

import { bytesToBigInt, unsignedBigIntToBytes } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';
import { setIrqWire, IRQ_LEVEL_MSIP, IRQ_LEVEL_MTIP } from '#emulator/memory/hart-wake';
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

/** Drive a level-sensitive CLINT IRQ wire (1 = pending) and publish into the hart-wake level word. */
const setClintIrqWire = (
  memory: Memory,
  wireOffset: number,
  pending: boolean,
  levelBit: number
): void => {
  setIrqWire(memory, memory.clintHostBaseIndex + wireOffset, pending, levelBit);
};

/** Drive the level-sensitive CLINT timer IRQ wire (1 = pending). */
const setClintTimerWire = (memory: Memory, pending: boolean): void => {
  setClintIrqWire(memory, CLINT_HOST_TIMER_WIRE_OFFSET, pending, IRQ_LEVEL_MTIP);
};

/** Level of the CLINT timer interrupt wire (sampled by the hart into `mip.MTIP`). */
const isClintMachineTimerPending = (memory: Memory): boolean =>
  Atomics.load(memory.bytes, memory.clintHostBaseIndex + CLINT_HOST_TIMER_WIRE_OFFSET) !== 0;

/** Drive the level-sensitive CLINT software IRQ wire (1 = pending). */
const setClintSoftwareWire = (memory: Memory, pending: boolean): void => {
  setClintIrqWire(memory, CLINT_HOST_SOFTWARE_WIRE_OFFSET, pending, IRQ_LEVEL_MSIP);
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

/**
 * Advance free-running `mtime` from the host clock and refresh the timer IRQ wire.
 * Called by the CLINT timebase worker and on guest `mtime` reads (sync-on-read).
 */
const tickClint = (memory: Memory): void => {
  const elapsedNs = process.hrtime.bigint() - readEpochNs(memory);
  const ticks = (elapsedNs * CLINT_TIMEBASE_HZ) / NS_PER_SECOND;
  writeTimeRegister(memory, 'mtime', ticks);
  updateTimerWireFromCompare(memory);
};

/** Initialize CLINT shadows: mtime = 0, mtimecmp = all-ones, wires clear. */
const initializeClint = (memory: Memory): void => {
  writeTimeRegister(memory, 'mtime', 0n);
  writeTimeRegister(memory, 'mtimecmp', 0xffff_ffff_ffff_ffffn);
  writeEpochNs(memory, process.hrtime.bigint());
  setClintTimerWire(memory, false);
  setClintSoftwareWire(memory, false);
};

/** Atomic u64 snapshot of `mtime` / `mtimecmp` into `destination` (no host-clock sync). */
const peekClintTimeRegister = (
  memory: Memory,
  register: ClintTimeRegister,
  destination: Uint8Array
): void => {
  unsignedBigIntToBytes(destination, readTimeRegister(memory, register));
};

/**
 * Atomic u64 load of `mtime` / `mtimecmp` into `destination` (8 bytes).
 * Syncs `mtime` from the host clock first so visible time is not only tick-stepped.
 */
const loadClintTimeRegister = (
  memory: Memory,
  register: ClintTimeRegister,
  destination: Uint8Array
): void => {
  if (register === 'mtime') {
    tickClint(memory);
  }
  peekClintTimeRegister(memory, register, destination);
};

/**
 * Atomic u64 store of `mtime` / `mtimecmp` from `source` (8 little-endian bytes).
 * Reseats the epoch once after a full `mtime` write.
 */
const storeClintTimeRegister = (
  memory: Memory,
  register: ClintTimeRegister,
  source: ReadonlyUint8Array
): void => {
  writeTimeRegister(memory, register, bytesToBigInt(source));
  if (register === 'mtime') {
    reseatEpochFromMtime(memory);
  }
  updateTimerWireFromCompare(memory);
};

/**
 * RMW one byte inside a time register via a single atomic u64 load/store
 * (avoids torn mid-word views vs `tickClint`). Full `mtime` writes reseat once.
 */
const storeClintTimeRegisterByte = (
  memory: Memory,
  register: ClintTimeRegister,
  byteOffset: number,
  value: number
): void => {
  const previous = readTimeRegister(memory, register);
  const shift = BigInt(byteOffset * 8);
  const next = (previous & ~(0xffn << shift)) | (BigInt(value & 0xff) << shift);
  writeTimeRegister(memory, register, next);
  if (register === 'mtime') {
    reseatEpochFromMtime(memory);
  }
  updateTimerWireFromCompare(memory);
};

const loadClintByte = (memory: Memory, register: ClintRegister, byteOffset: number): number => {
  switch (register) {
    case 'msip':
      // Only byte 0 bit 0 is defined (software IRQ wire).
      return byteOffset === 0 && isClintMachineSoftwarePending(memory) ? 1 : 0;
    case 'mtime':
      if (byteOffset === 0) {
        tickClint(memory);
      }
      return Number((readTimeRegister(memory, register) >> BigInt(byteOffset * 8)) & 0xffn);
    case 'mtimecmp':
      return Number((readTimeRegister(memory, register) >> BigInt(byteOffset * 8)) & 0xffn);
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
      // Only byte 0 bit 0 is defined (software IRQ wire).
      if (byteOffset === 0) {
        setClintSoftwareWire(memory, (value & 1) !== 0);
      }
      return;
    case 'mtime':
    case 'mtimecmp':
      storeClintTimeRegisterByte(memory, register, byteOffset, value);
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
  loadClintTimeRegister,
  peekClintTimeRegister,
  storeClintByte,
  storeClintTimeRegister,
};
