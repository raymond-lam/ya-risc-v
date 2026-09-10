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

import { addBytes, bytesToBigInt, copyBytes, signedNumberToBytes } from '#utils/bytes.js';
import type { Memory, ReadonlyUint8Array } from '#types.js';

/** 16550 register window size (RBR/THR … SCR). FIFO state is device-private, not MMIO. */
const UART_SIZE = 8n;

const ONE_BYTE = signedNumberToBytes(new Uint8Array(8), 1, 32) as ReadonlyUint8Array;

/**
 * Map a guest physical address to a host index in the packed `memory.bytes` buffer,
 * or `null` if unmapped. The address stays an architectural byte array; `bigint` is
 * used only for the range compare. The returned host offset is a TypedArray index.
 */
const hostIndex = (memory: Memory, address: ReadonlyUint8Array): number | null => {
  const guestAddress = bytesToBigInt(address);
  const ramBase = bytesToBigInt(memory.ramBaseAddress);
  const ramEnd = ramBase + memory.ramSize;
  const uartBase = bytesToBigInt(memory.uartBaseAddress);
  const uartEnd = uartBase + UART_SIZE;

  if (guestAddress >= uartBase && guestAddress < uartEnd) {
    return Number(memory.ramSize + (guestAddress - uartBase));
  }
  if (guestAddress >= ramBase && guestAddress < ramEnd) {
    return Number(guestAddress - ramBase);
  }
  return null;
};

/**
 * Allocate a SharedArrayBuffer large enough for RAM plus the packed UART window.
 * Returns only the byte view; the caller builds a `Memory` record around it.
 */
const createMemory = ({
  ramBaseAddress,
  ramSize,
  uartBaseAddress,
}: {
  ramBaseAddress: ReadonlyUint8Array;
  ramSize: bigint;
  uartBaseAddress: ReadonlyUint8Array;
}): Uint8Array => {
  if (ramSize < 0n) {
    throw new RangeError('ramSize must be non-negative');
  }
  const ramBase = bytesToBigInt(ramBaseAddress);
  const uartBase = bytesToBigInt(uartBaseAddress);
  if (ramSize !== 0n && ramBase < uartBase + UART_SIZE && uartBase < ramBase + ramSize) {
    throw new RangeError('UART window overlaps RAM');
  }
  // Region sizes are bigint (guest map math); the packed host buffer length is a number.
  return new Uint8Array(new SharedArrayBuffer(Number(ramSize + UART_SIZE)));
};

/** Copy `byteLength` bytes from `memory` at `address` into `destination` (high bytes cleared). */
const loadBytes = ({
  destination,
  memory,
  address,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  byteLength: number;
}): void => {
  destination.fill(0);
  const cursor = copyBytes(new Uint8Array(8), address);
  for (let index = 0; index < byteLength; index += 1) {
    const host = hostIndex(memory, cursor);
    destination[index] = host === null ? 0 : (memory.bytes[host] ?? 0);
    addBytes(cursor, cursor, ONE_BYTE);
  }
};

/** Copy `byteLength` bytes from `source` into `memory` at `address`. */
const storeBytes = ({
  memory,
  address,
  source,
  byteLength,
}: {
  memory: Memory;
  address: ReadonlyUint8Array;
  source: ReadonlyUint8Array;
  byteLength: number;
}): void => {
  const cursor = copyBytes(new Uint8Array(8), address);
  for (let index = 0; index < byteLength; index += 1) {
    const host = hostIndex(memory, cursor);
    if (host !== null) {
      memory.bytes[host] = source[index] ?? 0;
    }
    addBytes(cursor, cursor, ONE_BYTE);
  }
};

export { createMemory, loadBytes, storeBytes };
