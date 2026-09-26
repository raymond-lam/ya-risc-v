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
const atomicLoad32 = ({ bytes, index }: { bytes: Uint8Array; index: number }): number => {
  const byteOffset = bytes.byteOffset + index;
  if (byteOffset % 4 !== 0) {
    throw new RangeError('atomicLoad32 index must be 4-byte aligned.');
  }
  return Atomics.load(new Int32Array(bytes.buffer, byteOffset, 1), 0) >>> 0;
};

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

export { atomicLoad32, atomicLoadBit, atomicUpdateBit };
