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

import { bytesToBigInt } from '#utils/bytes.js';

/**
 * Guest memory as a `Uint8Array` over a `SharedArrayBuffer`, shared with the CPU worker.
 * Access is plain byte reads and writes rather than `Atomics`, so host and guest race like
 * unsynchronized access to real memory.
 */
const createMemory = (byteLength: number): Uint8Array =>
  new Uint8Array(new SharedArrayBuffer(byteLength));

/** Copy `byteLength` bytes from `memory` at `address` into `destination` (high bytes cleared). */
const loadBytes = ({
  destination,
  memory,
  address,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Uint8Array;
  address: Uint8Array;
  byteLength: number;
}): void => {
  destination.fill(0);
  const guestAddress = bytesToBigInt(address);
  if (guestAddress >= BigInt(memory.byteLength)) {
    return;
  }
  const start = Number(guestAddress);
  for (let index = 0; index < byteLength; index += 1) {
    destination[index] = memory[start + index] ?? 0;
  }
};

/** Copy `byteLength` bytes from `source` into `memory` at `address`. */
const storeBytes = ({
  memory,
  address,
  source,
  byteLength,
}: {
  memory: Uint8Array;
  address: Uint8Array;
  source: Uint8Array;
  byteLength: number;
}): void => {
  const guestAddress = bytesToBigInt(address);
  if (guestAddress >= BigInt(memory.byteLength)) {
    return;
  }
  const start = Number(guestAddress);
  for (let index = 0; index < byteLength; index += 1) {
    memory[start + index] = source[index] ?? 0;
  }
};

export { createMemory, loadBytes, storeBytes };
