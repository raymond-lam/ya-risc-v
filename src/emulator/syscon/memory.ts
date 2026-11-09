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

import type { Memory } from '#emulator/memory';
import {
  SYSCON_GUEST_BYTE_LENGTH,
  SYSCON_REGISTER_BYTES,
  SYSCON_REGISTER_COUNT,
  sysconHostIndex,
} from '#emulator/syscon/layout';
import { publishSysconRequest } from '#emulator/syscon/watch';
import type { ReadonlyUint8Array } from '#types';
import { atomicLoad32, atomicUpdate32 } from '#utils/atomics';

/**
 * Bytes of this access that fall inside one register.
 * `mask` and `value` are little-endian bits of that 32-bit word.
 */
const registerUpdate = (
  offset: number,
  source: ReadonlyUint8Array,
  byteLength: number,
  wordOffset: number
): { mask: number; value: number } => {
  const window = Number(SYSCON_GUEST_BYTE_LENGTH);
  let mask = 0;
  let value = 0;
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const registerOffset = offset + byteIndex;
    if (registerOffset < wordOffset || registerOffset >= wordOffset + SYSCON_REGISTER_BYTES) {
      continue;
    }
    if (registerOffset < 0 || registerOffset >= window) {
      continue;
    }
    const shift = (registerOffset - wordOffset) * 8;
    mask |= 0xff << shift;
    value |= ((source[byteIndex] ?? 0) & 0xff) << shift;
  }
  return { mask: mask >>> 0, value: value >>> 0 };
};

/** Guest load of `byteLength` syscon bytes starting at `offset`. */
const loadBytesFromSyscon = ({
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
  const base = sysconHostIndex(memory);
  const start = Number(offset);
  const window = Number(SYSCON_GUEST_BYTE_LENGTH);
  const words = new Array<number | undefined>(SYSCON_REGISTER_COUNT);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const registerOffset = start + byteIndex;
    if (registerOffset < 0 || registerOffset >= window) {
      destination[byteIndex] = 0;
      continue;
    }
    const wordIndex = registerOffset >>> 2;
    let word = words[wordIndex];
    if (word === undefined) {
      word = atomicLoad32({ bytes: memory.bytes, index: base + wordIndex * SYSCON_REGISTER_BYTES });
      words[wordIndex] = word;
    }
    destination[byteIndex] = (word >>> ((registerOffset & 3) * 8)) & 0xff;
  }
};

/** Guest store of `byteLength` syscon bytes starting at `offset`. */
const storeBytesToSyscon = ({
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
  const base = sysconHostIndex(memory);
  const start = Number(offset);
  for (let wordIndex = 0; wordIndex < SYSCON_REGISTER_COUNT; wordIndex += 1) {
    const wordOffset = wordIndex * SYSCON_REGISTER_BYTES;
    const update = registerUpdate(start, source, byteLength, wordOffset);
    if (update.mask === 0) {
      continue;
    }
    atomicUpdate32({
      bytes: memory.bytes,
      index: base + wordOffset,
      mask: update.mask,
      value: update.value,
    });
  }
  publishSysconRequest(memory);
};

export { loadBytesFromSyscon, storeBytesToSyscon };
