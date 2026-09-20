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

import { addBytes, bytesToBigInt, copyBytes, signedNumberToBytes } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';
import { findOverlappingPair } from '#utils/ranges';
import {
  CLINT_WINDOW_SIZE,
  initializeClint,
  loadClintByte,
  storeClintByte,
} from '#emulator/memory/clint';
import { guestMemoryHostLayout, locationFromGuestAddress } from '#emulator/memory/layout';
import { loadRamByte, ramAddressToHostIndex, storeRamByte } from '#emulator/memory/ram';
import {
  UART_REGISTER_WINDOW,
  loadUartRegister,
  popTransmit,
  pushReceive,
  storeUartRegister,
} from '#emulator/memory/uart';
import type { Memory } from '#emulator/memory/types';

const ONE_BYTE = signedNumberToBytes(new Uint8Array(8), 1, 32) as ReadonlyUint8Array;

/**
 * Allocate guest memory (RAM + UART queues + CLINT shadows in one SharedArrayBuffer)
 * and initialize the CLINT timebase (`mtime` = 0, `mtimecmp` = all-ones).
 */
const createMemory = ({
  ramBaseAddress,
  ramSize,
  uartBaseAddress,
  clintBaseAddress,
}: {
  ramBaseAddress: ReadonlyUint8Array;
  ramSize: bigint;
  uartBaseAddress: ReadonlyUint8Array;
  clintBaseAddress: ReadonlyUint8Array;
}): Memory => {
  if (ramSize < 0n) {
    throw new RangeError('ramSize must be non-negative.');
  }
  const overlap = findOverlappingPair([
    { name: 'UART', base: bytesToBigInt(uartBaseAddress), size: BigInt(UART_REGISTER_WINDOW) },
    { name: 'CLINT', base: bytesToBigInt(clintBaseAddress), size: CLINT_WINDOW_SIZE },
    { name: 'RAM', base: bytesToBigInt(ramBaseAddress), size: ramSize },
  ]);
  if (overlap !== null) {
    throw new RangeError(`${overlap.a.name} window overlaps ${overlap.b.name}.`);
  }
  const {
    uartRegistersHostIndex,
    uartMetaHostIndex,
    uartRxDataHostIndex,
    uartTxDataHostIndex,
    clintHostBaseIndex,
    hartWakeHostIndex,
    packedByteLength,
  } = guestMemoryHostLayout(ramSize);
  const memory: Memory = {
    bytes: new Uint8Array(new SharedArrayBuffer(packedByteLength)),
    ramBaseAddress,
    ramSize,
    uartBaseAddress,
    clintBaseAddress,
    uartRegistersHostIndex,
    uartMetaHostIndex,
    uartRxDataHostIndex,
    uartTxDataHostIndex,
    clintHostBaseIndex,
    hartWakeHostIndex,
  };
  initializeClint(memory);
  return memory;
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
    const location = locationFromGuestAddress(memory, addressCursor);
    switch (location.region) {
      case 'uart':
        destination[byteIndex] = loadUartRegister(memory, location.registerIndex);
        break;
      case 'clint':
        destination[byteIndex] = loadClintByte(memory, location.register, location.byteOffset);
        break;
      case 'ram': {
        const hostIndex = ramAddressToHostIndex(memory, addressCursor);
        destination[byteIndex] = hostIndex === null ? 0 : loadRamByte(memory, hostIndex);
        break;
      }
      case 'unmapped':
        destination[byteIndex] = 0;
        break;
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
    const location = locationFromGuestAddress(memory, addressCursor);
    switch (location.region) {
      case 'uart':
        storeUartRegister(memory, location.registerIndex, value);
        break;
      case 'clint':
        storeClintByte(memory, location.register, location.byteOffset, value);
        break;
      case 'ram': {
        const hostIndex = ramAddressToHostIndex(memory, addressCursor);
        if (hostIndex !== null) {
          storeRamByte(memory, hostIndex, value);
        }
        break;
      }
      case 'unmapped':
        break;
    }
    addBytes(addressCursor, addressCursor, ONE_BYTE);
  }
};

export { createMemory, loadBytes, popTransmit, pushReceive, storeBytes, ramAddressToHostIndex };
export {
  isClintMachineSoftwarePending,
  isClintMachineTimerPending,
  tickClint,
} from '#emulator/memory/clint';
export { readHartWake, waitHartWake } from '#emulator/memory/hart-wake';
export type { Memory } from '#emulator/memory/types';
