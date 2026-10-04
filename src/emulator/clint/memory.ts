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
 * CLINT guest loadBytes / storeBytes (window decode + register side effects).
 */

import type { ReadonlyUint8Array } from '#types';
import {
  CLINT_REGISTER_SIZE,
  clintOffsetToRegister,
  type ClintRegister,
  type ClintTimeRegister,
} from '#emulator/clint/layout';
import {
  loadClintTimeBytes,
  loadClintTimeRegisterByte,
  storeClintTimeBytes,
  storeClintTimeRegisterByte,
} from '#emulator/clint/time';
import { isClintMachineSoftwarePending, setClintSoftwareWire } from '#emulator/clint/wires';
import type { Memory } from '#emulator/memory';

/** True when `byteLength` bytes from `offset` lie entirely inside `mtime` or `mtimecmp`. */
const isClintTimeRegisterTransfer = (
  offset: bigint,
  byteLength: number
): { register: ClintTimeRegister; byteOffset: number } | null => {
  if (byteLength <= 0) {
    return null;
  }
  const decoded = clintOffsetToRegister(offset);
  if (
    decoded === null ||
    (decoded.register !== 'mtime' && decoded.register !== 'mtimecmp') ||
    decoded.byteOffset + byteLength > CLINT_REGISTER_SIZE
  ) {
    return null;
  }
  const end = clintOffsetToRegister(offset + BigInt(byteLength - 1));
  if (end === null || end.register !== decoded.register) {
    return null;
  }
  return { register: decoded.register, byteOffset: decoded.byteOffset };
};

const loadClintByte = (memory: Memory, register: ClintRegister, byteOffset: number): number => {
  switch (register) {
    case 'msip':
      // Only byte 0 bit 0 is defined (software IRQ wire).
      return byteOffset === 0 && isClintMachineSoftwarePending(memory) ? 1 : 0;
    case 'mtime':
    case 'mtimecmp':
      return loadClintTimeRegisterByte(memory, register, byteOffset);
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

/** Guest load of `byteLength` CLINT bytes starting at window `offset`. */
const loadBytesFromClint = ({
  destination,
  memory,
  offset,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  byteLength: number;
}): void => {
  const time = isClintTimeRegisterTransfer(offset, byteLength);
  if (time !== null) {
    loadClintTimeBytes(memory, time.register, time.byteOffset, destination, byteLength);
    return;
  }
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const decoded = clintOffsetToRegister(offset + BigInt(byteIndex));
    destination[byteIndex] =
      decoded === null ? 0 : loadClintByte(memory, decoded.register, decoded.byteOffset);
  }
};

/** Guest store of `byteLength` CLINT bytes starting at window `offset`. */
const storeBytesToClint = ({
  memory,
  offset,
  source,
  byteLength,
}: {
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  source: ReadonlyUint8Array;
  byteLength: number;
}): void => {
  const time = isClintTimeRegisterTransfer(offset, byteLength);
  if (time !== null) {
    storeClintTimeBytes(memory, time.register, time.byteOffset, source, byteLength);
    return;
  }
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const decoded = clintOffsetToRegister(offset + BigInt(byteIndex));
    if (decoded !== null) {
      storeClintByte(memory, decoded.register, decoded.byteOffset, source[byteIndex] ?? 0);
    }
  }
};

export { loadBytesFromClint, storeBytesToClint };
