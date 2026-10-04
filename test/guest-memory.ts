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

import {
  CLINT_GUEST_BYTE_LENGTH,
  CLINT_HOST_BYTE_LENGTH,
  CLINT_REGION_ID,
  initializeClint,
} from '#emulator/clint';
import { IRQ_LEVEL_HOST_BYTE_LENGTH, IRQ_LEVEL_REGION_ID } from '#emulator/irq-level';
import { createMemory, type Memory } from '#emulator/memory';
import {
  PLIC_GUEST_BYTE_LENGTH,
  PLIC_HOST_BYTE_LENGTH,
  PLIC_REGION_ID,
  initializePlic,
} from '#emulator/plic';
import { RAM_REGION_ID } from '#emulator/ram';
import { RESERVATION_HOST_BYTE_LENGTH, RESERVATION_REGION_ID } from '#emulator/reservation';
import { UART_GUEST_BYTE_LENGTH, UART_HOST_BYTE_LENGTH, UART_REGION_ID } from '#emulator/uart';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes } from '#utils/bytes';

/** Test map: RAM at guest physical address 0; UART/CLINT/PLIC at fixed MMIO bases. */
const RAM_BASE_ADDRESS = new Uint8Array(8) as ReadonlyUint8Array;
const UART_BASE_ADDRESS = unsignedBigIntToBytes(
  new Uint8Array(8),
  0x1000_0000n
) as ReadonlyUint8Array;
const CLINT_BASE_ADDRESS = unsignedBigIntToBytes(
  new Uint8Array(8),
  0x0200_0000n
) as ReadonlyUint8Array;
const PLIC_BASE_ADDRESS = unsignedBigIntToBytes(
  new Uint8Array(8),
  0x0c00_0000n
) as ReadonlyUint8Array;

/** Standard machine region list (pack order: ram → uart → clint → plic → reservation → irqLevel). */
const machineRegionSpecs = ({
  ramBaseAddress,
  ramSize,
  uartBaseAddress,
  clintBaseAddress,
  plicBaseAddress,
}: {
  ramBaseAddress: ReadonlyUint8Array;
  ramSize: bigint;
  uartBaseAddress: ReadonlyUint8Array;
  clintBaseAddress: ReadonlyUint8Array;
  plicBaseAddress: ReadonlyUint8Array;
}): Parameters<typeof createMemory>[0] => {
  if (ramSize < 0n) {
    throw new RangeError('ramSize must be non-negative.');
  }
  return [
    {
      id: RAM_REGION_ID,
      hostByteLength: ramSize,
      guestAddress: ramBaseAddress,
      guestByteLength: ramSize,
    },
    {
      id: UART_REGION_ID,
      hostByteLength: UART_HOST_BYTE_LENGTH,
      guestAddress: uartBaseAddress,
      guestByteLength: UART_GUEST_BYTE_LENGTH,
    },
    {
      id: CLINT_REGION_ID,
      hostByteLength: CLINT_HOST_BYTE_LENGTH,
      guestAddress: clintBaseAddress,
      guestByteLength: CLINT_GUEST_BYTE_LENGTH,
    },
    {
      id: PLIC_REGION_ID,
      hostByteLength: PLIC_HOST_BYTE_LENGTH,
      guestAddress: plicBaseAddress,
      guestByteLength: PLIC_GUEST_BYTE_LENGTH,
    },
    {
      id: RESERVATION_REGION_ID,
      hostByteLength: RESERVATION_HOST_BYTE_LENGTH,
      guestAddress: null,
      guestByteLength: 0n,
    },
    {
      id: IRQ_LEVEL_REGION_ID,
      hostByteLength: IRQ_LEVEL_HOST_BYTE_LENGTH,
      guestAddress: null,
      guestByteLength: 0n,
    },
  ];
};

const createTestMemory = (ramSize: bigint): Memory => {
  const memory = createMemory(
    machineRegionSpecs({
      ramBaseAddress: RAM_BASE_ADDRESS,
      ramSize,
      uartBaseAddress: UART_BASE_ADDRESS,
      clintBaseAddress: CLINT_BASE_ADDRESS,
      plicBaseAddress: PLIC_BASE_ADDRESS,
    })
  );
  initializeClint(memory);
  initializePlic(memory);
  return memory;
};

export { machineRegionSpecs };
export default createTestMemory;
