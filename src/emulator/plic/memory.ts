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
 * PLIC guest loadBytes / storeBytes (window decode + claim/complete side effects).
 */

import type { ReadonlyUint8Array } from '#types';
import {
  isValidSource,
  plicAddressToLocation,
  plicHostIndexForLocation,
} from '#emulator/plic/layout';
import {
  claimPlicSource,
  completePlicSource,
  refreshAllContextWires,
  refreshContextWire,
  withPlicGatewayLock,
} from '#emulator/plic/gateway';
import type { Memory } from '#emulator/memory';
import { addBytes, copyBytes, signedNumberToBytes } from '#utils/bytes';

/** Load one guest PLIC byte at `address`. Claim side-effects on the low byte only. */
const loadPlicByte = (memory: Memory, address: ReadonlyUint8Array): number => {
  const location = plicAddressToLocation(memory, address);
  if (location === null) {
    return 0;
  }
  if (location.kind === 'claim') {
    // Side effect once on the low byte (little-endian `lw` hits byte 0 first). Ids ≤ 31.
    if (location.byteOffset !== 0) {
      return 0;
    }
    return claimPlicSource(memory, location.context) & 0xff;
  }
  if (location.kind === 'priority' && location.source === 0) {
    return 0;
  }
  return Atomics.load(memory.bytes, plicHostIndexForLocation(memory, location));
};

/** Store one guest PLIC byte at `address`. Pending is device-driven (stores ignored). */
const storePlicByte = (memory: Memory, address: ReadonlyUint8Array, value: number): void => {
  const location = plicAddressToLocation(memory, address);
  if (location === null) {
    return;
  }
  const byte = value & 0xff;
  switch (location.kind) {
    case 'priority':
      if (location.source === 0) {
        return;
      }
      withPlicGatewayLock(memory, () => {
        Atomics.store(memory.bytes, plicHostIndexForLocation(memory, location), byte);
        refreshAllContextWires(memory);
      });
      return;
    case 'pending':
      return;
    case 'enable': {
      const index = plicHostIndexForLocation(memory, location);
      // Source 0 enable bit is reserved; clear it when writing byte 0.
      withPlicGatewayLock(memory, () => {
        Atomics.store(memory.bytes, index, location.byteOffset === 0 ? byte & ~1 : byte);
        refreshContextWire(memory, location.context);
      });
      return;
    }
    case 'threshold':
      withPlicGatewayLock(memory, () => {
        Atomics.store(memory.bytes, plicHostIndexForLocation(memory, location), byte);
        refreshContextWire(memory, location.context);
      });
      return;
    case 'claim': {
      // Guests store a full u32; accept the low byte as the source id (sources are ≤ 31).
      if (location.byteOffset !== 0 || !isValidSource(byte)) {
        return;
      }
      completePlicSource(memory, location.context, byte);
      return;
    }
  }
};

const ONE_BYTE = signedNumberToBytes(new Uint8Array(8), 1, 32) as ReadonlyUint8Array;

/** Guest load of `byteLength` PLIC bytes starting at `address` / window `offset`. */
const loadBytesFromPlic = ({
  destination,
  memory,
  address,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  byteLength: number;
}): void => {
  const addressCursor = copyBytes(new Uint8Array(8), address);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    destination[byteIndex] = loadPlicByte(memory, addressCursor);
    addBytes(addressCursor, addressCursor, ONE_BYTE);
  }
};

/** Guest store of `byteLength` PLIC bytes starting at `address` / window `offset`. */
const storeBytesToPlic = ({
  memory,
  address,
  source,
  byteLength,
}: {
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  source: ReadonlyUint8Array;
  byteLength: number;
}): void => {
  const addressCursor = copyBytes(new Uint8Array(8), address);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    storePlicByte(memory, addressCursor, source[byteIndex] ?? 0);
    addBytes(addressCursor, addressCursor, ONE_BYTE);
  }
};

export { loadBytesFromPlic, storeBytesToPlic };
