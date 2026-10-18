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
 * Physical Memory Protection for 16 entries (pmpcfg0, pmpcfg2, pmpaddr0–15).
 * Grain is 4 bytes, so NA4 is legal. No Smepmp (`mseccfg` stays unimplemented).
 * The lowest entry that overlaps an access must cover every byte of it.
 * M-mode ignores an entry unless it is locked. S-mode and U-mode fault when nothing matches.
 */

import type { Registers } from '#emulator/cpu/types';
import type { ReadonlyUint8Array } from '#types';
import {
  bytesToBigInt,
  compareUnsignedBytes,
  signedNumberToBytes,
  unsignedBigIntToBytes,
} from '#utils/bytes';

/** pmpcfg0 holds entries 0–7. pmpcfg2 holds entries 8–15. Odd pmpcfg numbers are RV32-only. */
const PMPCFG0 = 0x3a0;
const PMPCFG2 = 0x3a2;
const PMPADDR0 = 0x3b0;
const PMP_ENTRY_COUNT = 16;

/** Config byte: R/W/X, A (OFF/TOR/NA4/NAPOT), reserved bits 6:5, L. */
const PMP_CFG_R = 0x01;
const PMP_CFG_W = 0x02;
const PMP_CFG_X = 0x04;
const PMP_CFG_A_MASK = 0x18;
const PMP_CFG_A_OFF = 0x00;
const PMP_CFG_A_TOR = 0x08;
const PMP_CFG_A_NA4 = 0x10;
const PMP_CFG_A_NAPOT = 0x18;
const PMP_CFG_RESERVED = 0x60;
const PMP_CFG_LOCK = 0x80;

/**
 * mstatus index and the bits PMP consults. MPP matches the register file:
 * machine is bits 12:11 equal to 11. MPRV is bit 17.
 */
const MSTATUS = 0x300;
const MSTATUS_BYTE2_MPRV = 0x02;
const MSTATUS_BYTE1_MPP_MASK = 0x18;
const MSTATUS_BYTE1_MPP_MACHINE = 0x18;
/** Same encoding as `registers.ts`. Copied here so this module does not import the register file. */
const PRIVILEGE_MACHINE = signedNumberToBytes(new Uint8Array(8), 3, 32);
/** RV64 `pmpaddr` holds address bits 55:2. Bits 63:54 read as zero. */
const PMPADDR_VALUE_MASK = (1n << 54n) - 1n;

type PmpAccess = 'load' | 'store' | 'amo' | 'fetch';

const isPmpCfgRegister = (index: number): boolean => index === PMPCFG0 || index === PMPCFG2;

const isPmpAddrRegister = (index: number): boolean =>
  index >= PMPADDR0 && index < PMPADDR0 + PMP_ENTRY_COUNT;

const isPmpControlAndStatusRegister = (index: number): boolean =>
  isPmpCfgRegister(index) || isPmpAddrRegister(index);

/** Drop reserved bits. W without R does not stick (no Smepmp). */
const legalizePmpCfgByte = (incoming: number): number => {
  let next = incoming & ~PMP_CFG_RESERVED;
  if ((next & PMP_CFG_W) !== 0 && (next & PMP_CFG_R) === 0) {
    next &= ~PMP_CFG_W;
  }
  return next;
};

/**
 * Merge a pmpcfg write. A locked byte stays as it was.
 * Returns a new buffer; `previous` is the live CSR slot.
 */
const legalizePmpCfg = (previous: ReadonlyUint8Array, incoming: ReadonlyUint8Array): Uint8Array => {
  const next = new Uint8Array(8);
  for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
    const prior = previous[byteIndex] ?? 0;
    next[byteIndex] =
      (prior & PMP_CFG_LOCK) !== 0 ? prior : legalizePmpCfgByte(incoming[byteIndex] ?? 0);
  }
  return next;
};

const configByte = (registers: Registers, entry: number): number => {
  const slot = entry < 8 ? PMPCFG0 : PMPCFG2;
  return registers.controlAndStatus[slot]![entry & 7] ?? 0;
};

/**
 * pmpaddr writes are ignored when that entry is locked.
 * A locked TOR entry also freezes the previous entry's address.
 */
const pmpAddressWriteIgnored = (registers: Registers, index: number): boolean => {
  const entry = index - PMPADDR0;
  if ((configByte(registers, entry) & PMP_CFG_LOCK) !== 0) {
    return true;
  }
  if (entry + 1 >= PMP_ENTRY_COUNT) {
    return false;
  }
  const next = configByte(registers, entry + 1);
  return (next & PMP_CFG_LOCK) !== 0 && (next & PMP_CFG_A_MASK) === PMP_CFG_A_TOR;
};

/** Keep the 54 implemented address bits. */
const legalizePmpAddr = (value: ReadonlyUint8Array): Uint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), bytesToBigInt(value) & PMPADDR_VALUE_MASK);

const readPmpAddress = (registers: Registers, entry: number): bigint =>
  bytesToBigInt(registers.controlAndStatus[PMPADDR0 + entry]!);

const trailingOnes = (value: bigint): number => {
  let count = 0;
  let bits = value;
  while ((bits & 1n) === 1n && count < 64) {
    count += 1;
    bits >>= 1n;
  }
  return count;
};

type PmpRange = { low: bigint; high: bigint };

/** Half-open byte range of one entry. OFF and an empty TOR match nothing. */
const entryRange = (registers: Registers, entry: number): PmpRange | undefined => {
  const mode = configByte(registers, entry) & PMP_CFG_A_MASK;
  if (mode === PMP_CFG_A_OFF) {
    return undefined;
  }
  const highBits = readPmpAddress(registers, entry);
  if (mode === PMP_CFG_A_TOR) {
    const low = entry === 0 ? 0n : readPmpAddress(registers, entry - 1) << 2n;
    const high = highBits << 2n;
    return low < high ? { low, high } : undefined;
  }
  if (mode === PMP_CFG_A_NA4) {
    const low = highBits << 2n;
    return { low, high: low + 4n };
  }
  if (mode !== PMP_CFG_A_NAPOT) {
    return undefined;
  }
  const ones = trailingOnes(highBits);
  if (ones >= 64) {
    return { low: 0n, high: 1n << 64n };
  }
  const encoded = (1n << BigInt(ones + 1)) - 1n;
  const low = (highBits & ~encoded) << 2n;
  return { low, high: low + (1n << BigInt(ones + 3)) };
};

const permissionGranted = (config: number, access: PmpAccess): boolean => {
  const read = (config & PMP_CFG_R) !== 0;
  const write = (config & PMP_CFG_W) !== 0;
  const execute = (config & PMP_CFG_X) !== 0;
  if (access === 'load') {
    return read;
  }
  if (access === 'store') {
    return write;
  }
  if (access === 'fetch') {
    return execute;
  }
  return read && write;
};

/** True when this access is checked as M-mode. Fetch ignores mstatus.MPRV. */
const accessIsMachine = (registers: Registers, access: PmpAccess): boolean => {
  if (access !== 'fetch') {
    const mstatus = registers.controlAndStatus[MSTATUS]!;
    if ((mstatus[2]! & MSTATUS_BYTE2_MPRV) !== 0) {
      return (mstatus[1]! & MSTATUS_BYTE1_MPP_MASK) === MSTATUS_BYTE1_MPP_MACHINE;
    }
  }
  return compareUnsignedBytes(registers.privilegeMode, PRIVILEGE_MACHINE) === 0;
};

/**
 * True when `[address, address + byteLength)` is forbidden.
 * The lowest entry that overlaps the access must cover every byte, or the access fails.
 */
const physicalMemoryAccessDenied = ({
  registers,
  address,
  byteLength,
  access,
}: {
  registers: Registers;
  address: ReadonlyUint8Array;
  byteLength: number;
  access: PmpAccess;
}): boolean => {
  const start = bytesToBigInt(address);
  const end = start + BigInt(byteLength);
  const machine = accessIsMachine(registers, access);
  for (let entry = 0; entry < PMP_ENTRY_COUNT; entry += 1) {
    const range = entryRange(registers, entry);
    if (range === undefined || end <= range.low || start >= range.high) {
      continue;
    }
    if (start < range.low || end > range.high) {
      return true;
    }
    const config = configByte(registers, entry);
    if (machine && (config & PMP_CFG_LOCK) === 0) {
      return false;
    }
    return !permissionGranted(config, access);
  }
  return !machine;
};

export {
  isPmpCfgRegister,
  isPmpAddrRegister,
  isPmpControlAndStatusRegister,
  legalizePmpAddr,
  legalizePmpCfg,
  pmpAddressWriteIgnored,
  physicalMemoryAccessDenied,
};
