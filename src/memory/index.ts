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

import { addBytes, copyBytes, signedNumberToBytes } from '#utils/bytes.js';
import { loadRamByte, ramAddressToHostIndex, storeRamByte } from '#memory/ram.js';
import {
  loadUartRegister,
  storeUartRegister,
  uartAddressToRegisterIndex,
  uartOverlapsRam,
  uartPackedByteLength,
} from '#memory/uart.js';
import type { Memory, ReadonlyUint8Array } from '#types.js';

const ONE_BYTE = signedNumberToBytes(new Uint8Array(8), 1, 32) as ReadonlyUint8Array;

/**
 * Allocate a SharedArrayBuffer for RAM, the UART register shadow, and RX/TX rings.
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
  if (uartOverlapsRam({ ramBaseAddress, ramSize, uartBaseAddress })) {
    throw new RangeError('UART window overlaps RAM');
  }
  return new Uint8Array(new SharedArrayBuffer(uartPackedByteLength(ramSize)));
};

/** Copy `byteLength` bytes from `memory` at guest `address` into `destination` (high bytes cleared). */
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
  const addressCursor = copyBytes(new Uint8Array(8), address);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const registerIndex = uartAddressToRegisterIndex(memory, addressCursor);
    if (registerIndex !== null) {
      destination[byteIndex] = loadUartRegister(memory, registerIndex);
    } else {
      const hostIndex = ramAddressToHostIndex(memory, addressCursor);
      destination[byteIndex] = hostIndex === null ? 0 : loadRamByte(memory, hostIndex);
    }
    addBytes(addressCursor, addressCursor, ONE_BYTE);
  }
};

/** Copy `byteLength` bytes from `source` into `memory` at guest `address`. */
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
  const addressCursor = copyBytes(new Uint8Array(8), address);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const value = source[byteIndex] ?? 0;
    const registerIndex = uartAddressToRegisterIndex(memory, addressCursor);
    if (registerIndex !== null) {
      storeUartRegister(memory, registerIndex, value);
    } else {
      const hostIndex = ramAddressToHostIndex(memory, addressCursor);
      if (hostIndex !== null) {
        storeRamByte(memory, hostIndex, value);
      }
    }
    addBytes(addressCursor, addressCursor, ONE_BYTE);
  }
};

export { createMemory, loadBytes, storeBytes };
