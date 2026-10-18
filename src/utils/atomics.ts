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
 * SharedArrayBuffer byte / bit Atomics helpers.
 */

import { bytesToInt32Array } from '#utils/bytes';

/** Atomically load bit `bit` (0..7) in the byte at `index`. */
const atomicLoadBit = ({
  bytes,
  index,
  bit,
}: {
  bytes: Uint8Array;
  index: number;
  bit: number;
}): boolean => (Atomics.load(bytes, index) & (1 << bit)) !== 0;

/**
 * Atomically load 32 little-endian bits at `index` as a JS `number`
 * (`index` must be 4-byte aligned).
 */
const atomicLoad32 = ({ bytes, index }: { bytes: Uint8Array; index: number }): number =>
  Atomics.load(bytesToInt32Array(bytes, index), 0) >>> 0;

/** Atomically set bit `bit` (0..7) in the byte at `index` to `value` (CAS-retry). */
const atomicUpdateBit = ({
  bytes,
  index,
  bit,
  value,
}: {
  bytes: Uint8Array;
  index: number;
  bit: number;
  value: boolean;
}): void => {
  const mask = 1 << bit;
  let previous = Atomics.load(bytes, index);
  for (;;) {
    const next = (value ? previous | mask : previous & ~mask) & 0xff;
    const current = Atomics.compareExchange(bytes, index, previous, next);
    if (current === previous) {
      return;
    }
    previous = current;
  }
};

/**
 * Atomically replace the bits selected by `mask` in the 32 little-endian bits at `index`
 * (`index` must be 4-byte aligned). A mask of all ones is one atomic store.
 */
const atomicUpdate32 = ({
  bytes,
  index,
  mask,
  value,
}: {
  bytes: Uint8Array;
  index: number;
  mask: number;
  value: number;
}): void => {
  const view = bytesToInt32Array(bytes, index);
  const bits = mask >>> 0;
  const replacement = (value >>> 0) & bits;
  if (bits === 0xffff_ffff) {
    Atomics.store(view, 0, replacement | 0);
    return;
  }
  let previous = Atomics.load(view, 0);
  for (;;) {
    const next = (((previous >>> 0) & (~bits >>> 0)) | replacement) >>> 0;
    const current = Atomics.compareExchange(view, 0, previous, next | 0);
    if (current === previous) {
      return;
    }
    previous = current;
  }
};

export { atomicLoad32, atomicLoadBit, atomicUpdate32, atomicUpdateBit };
