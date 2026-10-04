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

/**
 * CLINT timebase — `mtime` / `mtimecmp` / epoch shadows and `tickClint`.
 */

import { bytesToBigInt, unsignedBigIntToBytes } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';
import {
  CLINT_HOST_EPOCH_NS_UINT64,
  CLINT_HOST_MTIMECMP_UINT64,
  CLINT_HOST_MTIME_UINT64,
  clintHostUint64s,
  type ClintTimeRegister,
} from '#emulator/clint/layout';
import { setClintTimerWire } from '#emulator/clint/wires';
import type { Memory } from '#emulator/memory';

/** Free-running `mtime` frequency (10 MHz timebase). */
const CLINT_TIMEBASE_HZ = 10_000_000n;
const NS_PER_SECOND = 1_000_000_000n;

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

/** Reset time shadows: `mtime` = 0, `mtimecmp` = all-ones, epoch = now, timer wire from compare. */
const resetClintTimebase = (memory: Memory): void => {
  writeTimeRegister(memory, 'mtime', 0n);
  writeTimeRegister(memory, 'mtimecmp', 0xffff_ffff_ffff_ffffn);
  writeEpochNs(memory, process.hrtime.bigint());
  updateTimerWireFromCompare(memory);
};

/**
 * Load `byteLength` bytes from `mtime` / `mtimecmp` starting at `byteOffset`.
 * One atomic u64 read (syncs `mtime` once) so multi-byte guest transfers do not tear.
 */
const loadClintTimeBytes = (
  memory: Memory,
  register: ClintTimeRegister,
  byteOffset: number,
  destination: Uint8Array,
  byteLength: number
): void => {
  if (register === 'mtime') {
    tickClint(memory);
  }
  const value = readTimeRegister(memory, register);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    destination[byteIndex] = Number((value >> BigInt((byteOffset + byteIndex) * 8)) & 0xffn);
  }
};

/**
 * Store `byteLength` bytes into `mtime` / `mtimecmp` starting at `byteOffset`.
 * Partial writes RMW one atomic u64; full aligned 8-byte writes replace the word.
 * Reseats the epoch once after any `mtime` write.
 */
const storeClintTimeBytes = (
  memory: Memory,
  register: ClintTimeRegister,
  byteOffset: number,
  source: ReadonlyUint8Array,
  byteLength: number
): void => {
  let next: bigint;
  if (byteLength === 8 && byteOffset === 0) {
    next = bytesToBigInt(source);
  } else {
    next = readTimeRegister(memory, register);
    for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
      const shift = BigInt((byteOffset + byteIndex) * 8);
      next = (next & ~(0xffn << shift)) | (BigInt((source[byteIndex] ?? 0) & 0xff) << shift);
    }
  }
  writeTimeRegister(memory, register, next);
  if (register === 'mtime') {
    reseatEpochFromMtime(memory);
  }
  updateTimerWireFromCompare(memory);
};

/** One byte of `mtime` / `mtimecmp` (syncs `mtime` once). */
const loadClintTimeRegisterByte = (
  memory: Memory,
  register: ClintTimeRegister,
  byteOffset: number
): number => {
  if (register === 'mtime') {
    tickClint(memory);
  }
  return Number((readTimeRegister(memory, register) >> BigInt(byteOffset * 8)) & 0xffn);
};

/** RMW one byte inside a time register via a single atomic u64 load/store. */
const storeClintTimeRegisterByte = (
  memory: Memory,
  register: ClintTimeRegister,
  byteOffset: number,
  value: number
): void => {
  storeClintTimeBytes(memory, register, byteOffset, Uint8Array.of(value & 0xff), 1);
};

/**
 * Architectural `mtime` for the unprivileged `time` CSR: sync-on-read then pack little-endian.
 */
const readClintMtimeBytes = (memory: Memory, destination: Uint8Array): Uint8Array => {
  tickClint(memory);
  return unsignedBigIntToBytes(destination, readTimeRegister(memory, 'mtime'));
};

export {
  loadClintTimeBytes,
  loadClintTimeRegisterByte,
  readClintMtimeBytes,
  resetClintTimebase,
  storeClintTimeBytes,
  storeClintTimeRegisterByte,
  tickClint,
};
