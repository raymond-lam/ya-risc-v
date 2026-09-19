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
import type { ReadonlyUint8Array } from '#utils/bytes';
import { rangesOverlap } from '#utils/ranges';
import {
  isClintMachineSoftwarePending,
  setClintSoftwareWire,
  setClintTimerWire,
} from '#emulator/clint/wire';
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
 * Host packing after UART in `memory.bytes`:
 *   [mtime 8][mtimecmp 8][timerWire 1][softwareWire 1][pad 6][epochNs 8]
 * Wire bytes are driven/sampled by `#emulator/clint/wire` (offsets 16 and 17).
 */
const CLINT_HOST_MTIME_OFFSET = 0;
const CLINT_HOST_MTIMECMP_OFFSET = 8;
const CLINT_HOST_EPOCH_NS_OFFSET = 24;
const CLINT_HOST_SIZE = 32;

/** Free-running `mtime` frequency (10 MHz timebase). */
const CLINT_TIMEBASE_HZ = 10_000_000n;
const NS_PER_SECOND = 1_000_000_000n;

type ClintTimeRegister = 'mtime' | 'mtimecmp';
type ClintRegister = 'msip' | ClintTimeRegister;

const clintOverlapsRam = ({
  ramBaseAddress,
  ramSize,
  clintBaseAddress,
}: {
  ramBaseAddress: ReadonlyUint8Array;
  ramSize: bigint;
  clintBaseAddress: ReadonlyUint8Array;
}): boolean =>
  rangesOverlap(
    bytesToBigInt(ramBaseAddress),
    ramSize,
    bytesToBigInt(clintBaseAddress),
    CLINT_WINDOW_SIZE
  );

const clintOverlapsUart = ({
  uartBaseAddress,
  clintBaseAddress,
}: {
  uartBaseAddress: ReadonlyUint8Array;
  clintBaseAddress: ReadonlyUint8Array;
}): boolean =>
  rangesOverlap(
    bytesToBigInt(uartBaseAddress),
    8n,
    bytesToBigInt(clintBaseAddress),
    CLINT_WINDOW_SIZE
  );

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

const timeRegisterHostIndex = (memory: Memory, register: ClintTimeRegister): number =>
  memory.clintHostBaseIndex +
  (register === 'mtime' ? CLINT_HOST_MTIME_OFFSET : CLINT_HOST_MTIMECMP_OFFSET);

const loadTimeRegisterByte = (
  memory: Memory,
  register: ClintTimeRegister,
  byteOffset: number
): number => memory.bytes[timeRegisterHostIndex(memory, register) + byteOffset] ?? 0;

const storeTimeRegisterByte = (
  memory: Memory,
  register: ClintTimeRegister,
  byteOffset: number,
  value: number
): void => {
  memory.bytes[timeRegisterHostIndex(memory, register) + byteOffset] = value & 0xff;
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

const readTimeRegister = (memory: Memory, register: ClintTimeRegister): bigint => {
  const index = timeRegisterHostIndex(memory, register);
  return bytesToBigInt(
    memory.bytes.subarray(index, index + CLINT_REGISTER_SIZE) as ReadonlyUint8Array
  );
};

const writeTimeRegister = (memory: Memory, register: ClintTimeRegister, value: bigint): void => {
  const index = timeRegisterHostIndex(memory, register);
  unsignedBigIntToBytes(memory.bytes.subarray(index, index + CLINT_REGISTER_SIZE), value);
};

const writeEpochNs = (memory: Memory, value: bigint): void => {
  const index = memory.clintHostBaseIndex + CLINT_HOST_EPOCH_NS_OFFSET;
  unsignedBigIntToBytes(memory.bytes.subarray(index, index + 8), value);
};

const readEpochNs = (memory: Memory): bigint => {
  const index = memory.clintHostBaseIndex + CLINT_HOST_EPOCH_NS_OFFSET;
  return bytesToBigInt(memory.bytes.subarray(index, index + 8) as ReadonlyUint8Array);
};

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
  tickClint,
  clintAddressToRegister,
  clintOverlapsRam,
  clintOverlapsUart,
  initializeClint,
  loadClintByte,
  storeClintByte,
};
