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
 * Guest UART loadBytes / storeBytes — dense 16550 window dispatch.
 */

import type { ReadonlyUint8Array } from '#types';
import type { Memory } from '#emulator/memory';
import { loadUartRegister, storeUartRegister } from '#emulator/uart/registers';
import { UART_GUEST_BYTE_LENGTH } from '#emulator/uart/region';

/** Guest load of `byteLength` UART register bytes starting at `offset`. */
const loadBytesFromUart = ({
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
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const registerIndex = Number(offset) + byteIndex;
    destination[byteIndex] =
      registerIndex >= 0 && registerIndex < Number(UART_GUEST_BYTE_LENGTH)
        ? loadUartRegister(memory, registerIndex)
        : 0;
  }
};

/** Guest store of `byteLength` UART register bytes starting at `offset`. */
const storeBytesToUart = ({
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
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const registerIndex = Number(offset) + byteIndex;
    if (registerIndex >= 0 && registerIndex < Number(UART_GUEST_BYTE_LENGTH)) {
      storeUartRegister(memory, registerIndex, source[byteIndex] ?? 0);
    }
  }
};

export { loadBytesFromUart, storeBytesToUart };
