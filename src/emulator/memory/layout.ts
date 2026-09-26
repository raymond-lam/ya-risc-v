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

import type { ReadonlyUint8Array } from '#types';
import { CLINT_HOST_SIZE, clintAddressToRegister } from '#emulator/memory/clint';
import { HART_WAKE_HOST_SIZE } from '#emulator/memory/hart-wake';
import { PLIC_HOST_SIZE, plicAddressToLocation } from '#emulator/memory/plic';
import { ramAddressToHostIndex } from '#emulator/memory/ram';
import {
  META_BYTE_COUNT,
  UART_QUEUE_CAPACITY,
  UART_REGISTER_WINDOW,
  uartAddressToRegisterIndex,
} from '#emulator/memory/uart';
import type { Memory } from '#emulator/memory/types';

/** Round `value` up to a multiple of `alignment` (power of two). */
const alignUp = (value: number, alignment: number): number =>
  (value + alignment - 1) & ~(alignment - 1);

/**
 * Lay out host regions sequentially, inserting pad bytes for each region's `align`.
 * Returns each region's base index and the exclusive end of the packed span.
 */
const packHostRegions = (
  regions: readonly { byteLength: number; align?: number }[],
  startIndex = 0
): { bases: readonly number[]; packedByteLength: number } => {
  let cursor = startIndex;
  const bases: number[] = [];
  for (const region of regions) {
    cursor = alignUp(cursor, region.align ?? 1);
    bases.push(cursor);
    cursor += region.byteLength;
  }
  return { bases, packedByteLength: cursor };
};

type GuestMemoryHostLayout = {
  uartRegistersHostIndex: number;
  uartMetaHostIndex: number;
  uartRxDataHostIndex: number;
  uartTxDataHostIndex: number;
  clintHostBaseIndex: number;
  plicHostBaseIndex: number;
  hartWakeHostIndex: number;
  packedByteLength: number;
};

/**
 * Full host packing for one guest memory SAB:
 *   [RAM][UART registers][queue meta bytes][RX ring][TX ring]
 *   [pad to 8][CLINT][pad to 4][PLIC][pad to 4][hart wake Int32]
 */
const guestMemoryHostLayout = (ramSize: bigint): GuestMemoryHostLayout => {
  const {
    bases: [
      ,
      uartRegistersHostIndex,
      uartMetaHostIndex,
      uartRxDataHostIndex,
      uartTxDataHostIndex,
      clintHostBaseIndex,
      plicHostBaseIndex,
      hartWakeHostIndex,
    ],
    packedByteLength,
  } = packHostRegions([
    { byteLength: Number(ramSize) },
    { byteLength: UART_REGISTER_WINDOW },
    { byteLength: META_BYTE_COUNT },
    { byteLength: UART_QUEUE_CAPACITY },
    { byteLength: UART_QUEUE_CAPACITY },
    { byteLength: CLINT_HOST_SIZE, align: 8 },
    { byteLength: PLIC_HOST_SIZE, align: 4 },
    { byteLength: HART_WAKE_HOST_SIZE, align: 4 },
  ]);
  return {
    uartRegistersHostIndex: uartRegistersHostIndex ?? 0,
    uartMetaHostIndex: uartMetaHostIndex ?? 0,
    uartRxDataHostIndex: uartRxDataHostIndex ?? 0,
    uartTxDataHostIndex: uartTxDataHostIndex ?? 0,
    clintHostBaseIndex: clintHostBaseIndex ?? 0,
    plicHostBaseIndex: plicHostBaseIndex ?? 0,
    hartWakeHostIndex: hartWakeHostIndex ?? 0,
    packedByteLength,
  };
};

type GuestLocation =
  | { region: 'uart'; registerIndex: number }
  | { region: 'clint'; register: 'msip' | 'mtime' | 'mtimecmp'; byteOffset: number }
  | { region: 'plic'; location: NonNullable<ReturnType<typeof plicAddressToLocation>> }
  | { region: 'ram' }
  | { region: 'unmapped' };

/** Map a guest physical address to the MMIO/RAM region that owns it. */
const locationFromGuestAddress = (memory: Memory, address: ReadonlyUint8Array): GuestLocation => {
  const uartRegisterIndex = uartAddressToRegisterIndex(memory, address);
  if (uartRegisterIndex !== null) {
    return { region: 'uart', registerIndex: uartRegisterIndex };
  }
  const clint = clintAddressToRegister(memory, address);
  if (clint !== null) {
    return { region: 'clint', register: clint.register, byteOffset: clint.byteOffset };
  }
  const plic = plicAddressToLocation(memory, address);
  if (plic !== null) {
    return { region: 'plic', location: plic };
  }
  if (ramAddressToHostIndex(memory, address) !== null) {
    return { region: 'ram' };
  }
  return { region: 'unmapped' };
};

export { guestMemoryHostLayout, locationFromGuestAddress };
