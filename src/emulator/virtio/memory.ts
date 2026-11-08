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

/** Virtio guest loadBytes / storeBytes — sparse MMIO window dispatch. */

import type { ReadonlyUint8Array } from '#types';
import type { Memory } from '#emulator/memory';
import { plicGatewayLockIndex } from '#emulator/plic';
import { loadVirtioRegisterBytes, storeVirtioRegisterBytes } from '#emulator/virtio/registers';

/** Guest load of `byteLength` bytes from the virtio window at `offset`. */
const loadBytesFromVirtio = ({
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
  loadVirtioRegisterBytes(memory, offset, destination, byteLength);
};

/** Guest store and side effects; caller holds the reservation and PLIC gateway locks. */
const storeBytesToVirtio = ({
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
  storeVirtioRegisterBytes(memory, offset, source, byteLength);
};

const virtioMemoryLockIndexes = (memory: Memory): readonly number[] => [
  plicGatewayLockIndex(memory),
];

export { loadBytesFromVirtio, storeBytesToVirtio, virtioMemoryLockIndexes };
