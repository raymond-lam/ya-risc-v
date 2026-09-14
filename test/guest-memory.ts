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

import { createMemory, type Memory, type ReadonlyUint8Array } from '#emulator/memory';
import { unsignedBigIntToBytes } from '#utils/bytes';

/** Test map: RAM at guest PA 0, UART at `0x1000_0000`. */
const RAM_BASE_ADDRESS = new Uint8Array(8) as ReadonlyUint8Array;
const UART_BASE_ADDRESS = unsignedBigIntToBytes(
  new Uint8Array(8),
  0x1000_0000n
) as ReadonlyUint8Array;

const createTestMemory = (ramSize: bigint): Memory => ({
  bytes: createMemory({
    ramBaseAddress: RAM_BASE_ADDRESS,
    ramSize,
    uartBaseAddress: UART_BASE_ADDRESS,
  }),
  ramBaseAddress: RAM_BASE_ADDRESS,
  ramSize,
  uartBaseAddress: UART_BASE_ADDRESS,
});

export default createTestMemory;
