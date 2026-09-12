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

import { bytesToBigInt } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#utils/bytes';
import type { Memory } from '#memory/types';

/**
 * Map a guest RAM address to a host index into `memory.bytes`, or `null` if the address
 * is outside the RAM window.
 */
const ramAddressToHostIndex = (memory: Memory, address: ReadonlyUint8Array): number | null => {
  const guestAddress = bytesToBigInt(address);
  const ramBase = bytesToBigInt(memory.ramBaseAddress);
  const ramEnd = ramBase + memory.ramSize;
  if (guestAddress >= ramBase && guestAddress < ramEnd) {
    return Number(guestAddress - ramBase);
  }
  return null;
};

const loadRamByte = (memory: Memory, hostIndex: number): number => memory.bytes[hostIndex] ?? 0;

const storeRamByte = (memory: Memory, hostIndex: number, value: number): void => {
  memory.bytes[hostIndex] = value & 0xff;
};

export { loadRamByte, ramAddressToHostIndex, storeRamByte };
