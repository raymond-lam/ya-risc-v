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

/** Copy `source` into `destination` (same length assumed). Returns `destination`. */
const copyBytes = (destination: Uint8Array, source: Uint8Array): Uint8Array => {
  for (let index = 0; index < destination.length; index += 1) {
    destination[index] = source[index] ?? 0;
  }
  return destination;
};

/** destination = source + addend (64-bit little-endian, wraps). Returns `destination`. */
const addBytes = (destination: Uint8Array, source: Uint8Array, addend: Uint8Array): Uint8Array => {
  let carry = 0;
  for (let index = 0; index < 8; index += 1) {
    const sum = (source[index] ?? 0) + (addend[index] ?? 0) + carry;
    destination[index] = sum & 0xff;
    carry = sum >>> 8;
  }
  return destination;
};

/** destination = minuend - subtrahend (64-bit little-endian, wraps). Returns `destination`. */
const subtractBytes = (
  destination: Uint8Array,
  minuend: Uint8Array,
  subtrahend: Uint8Array
): Uint8Array => {
  let borrow = 0;
  for (let index = 0; index < 8; index += 1) {
    const difference = (minuend[index] ?? 0) - (subtrahend[index] ?? 0) - borrow;
    destination[index] = difference & 0xff;
    borrow = difference < 0 ? 1 : 0;
  }
  return destination;
};

/** destination = source & mask (64-bit little-endian). Returns `destination`. */
const andBytes = (destination: Uint8Array, source: Uint8Array, mask: Uint8Array): Uint8Array => {
  for (let index = 0; index < 8; index += 1) {
    destination[index] = (source[index] ?? 0) & (mask[index] ?? 0);
  }
  return destination;
};

/** destination = source | mask (64-bit little-endian). Returns `destination`. */
const orBytes = (destination: Uint8Array, source: Uint8Array, mask: Uint8Array): Uint8Array => {
  for (let index = 0; index < 8; index += 1) {
    destination[index] = (source[index] ?? 0) | (mask[index] ?? 0);
  }
  return destination;
};

/** destination = source ^ mask (64-bit little-endian). Returns `destination`. */
const xorBytes = (destination: Uint8Array, source: Uint8Array, mask: Uint8Array): Uint8Array => {
  for (let index = 0; index < 8; index += 1) {
    destination[index] = (source[index] ?? 0) ^ (mask[index] ?? 0);
  }
  return destination;
};

/** True if all 8 bytes are zero. */
const isZeroBytes = (bytes: Uint8Array): boolean => {
  for (let index = 0; index < 8; index += 1) {
    if ((bytes[index] ?? 0) !== 0) {
      return false;
    }
  }
  return true;
};

/** Compare as unsigned 64-bit; returns -1, 0, or 1. */
const compareUnsignedBytes = (left: Uint8Array, right: Uint8Array): number => {
  for (let index = 7; index >= 0; index -= 1) {
    const leftByte = left[index] ?? 0;
    const rightByte = right[index] ?? 0;
    if (leftByte !== rightByte) {
      return leftByte < rightByte ? -1 : 1;
    }
  }
  return 0;
};

/** Compare as signed 64-bit; returns -1, 0, or 1. */
const compareSignedBytes = (left: Uint8Array, right: Uint8Array): number => {
  const leftNegative = ((left[7] ?? 0) & 0x80) !== 0;
  const rightNegative = ((right[7] ?? 0) & 0x80) !== 0;
  if (leftNegative !== rightNegative) {
    return leftNegative ? -1 : 1;
  }
  return compareUnsignedBytes(left, right);
};

const shiftLeftBytes = (
  destination: Uint8Array,
  source: Uint8Array,
  shiftAmount: number
): Uint8Array => {
  const amount = shiftAmount & 63;
  destination.fill(0);
  const byteShift = amount >>> 3;
  const bitShift = amount & 7;
  for (let index = 7; index >= byteShift; index -= 1) {
    const sourceIndex = index - byteShift;
    let value = (source[sourceIndex] ?? 0) << bitShift;
    if (bitShift !== 0 && sourceIndex > 0) {
      value |= (source[sourceIndex - 1] ?? 0) >>> (8 - bitShift);
    }
    destination[index] = value & 0xff;
  }
  return destination;
};

const shiftRightLogicalBytes = (
  destination: Uint8Array,
  source: Uint8Array,
  shiftAmount: number
): Uint8Array => {
  const amount = shiftAmount & 63;
  destination.fill(0);
  const byteShift = amount >>> 3;
  const bitShift = amount & 7;
  for (let index = 0; index < 8 - byteShift; index += 1) {
    const sourceIndex = index + byteShift;
    let value = (source[sourceIndex] ?? 0) >>> bitShift;
    if (bitShift !== 0 && sourceIndex < 7) {
      value |= (source[sourceIndex + 1] ?? 0) << (8 - bitShift);
    }
    destination[index] = value & 0xff;
  }
  return destination;
};

const shiftRightArithmeticBytes = (
  destination: Uint8Array,
  source: Uint8Array,
  shiftAmount: number
): Uint8Array => {
  const amount = shiftAmount & 63;
  const signByte = ((source[7] ?? 0) & 0x80) !== 0 ? 0xff : 0x00;
  shiftRightLogicalBytes(destination, source, amount);
  if (signByte === 0) {
    return destination;
  }
  // Fill shifted-in bits with ones.
  const byteShift = amount >>> 3;
  const bitShift = amount & 7;
  for (let index = 8 - byteShift; index < 8; index += 1) {
    destination[index] = 0xff;
  }
  if (bitShift !== 0 && byteShift < 8) {
    const topIndex = 7 - byteShift;
    const mask = (0xff << (8 - bitShift)) & 0xff;
    destination[topIndex] = (destination[topIndex] ?? 0) | mask;
  }
  return destination;
};

/** Copy the low 32 bits of `source` into `destination` (high bytes zero). Returns `destination`. */
const low32Bytes = (destination: Uint8Array, source: Uint8Array): Uint8Array => {
  destination[0] = source[0] ?? 0;
  destination[1] = source[1] ?? 0;
  destination[2] = source[2] ?? 0;
  destination[3] = source[3] ?? 0;
  destination[4] = 0;
  destination[5] = 0;
  destination[6] = 0;
  destination[7] = 0;
  return destination;
};

/**
 * Read the first 4 little-endian bytes as an unsigned 32-bit number (bytes[4..7] ignored).
 * For 32-bit instruction encodings only — not for guest addresses.
 */
const bytesToNumber = (bytes: Uint8Array): number =>
  ((bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8) | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 24)) >>>
  0;

/** Read 8 little-endian bytes as an exact unsigned 64-bit `bigint` (guest addresses). */
const bytesToBigInt = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0);
  }
  return value;
};

/** `bytes[0] & mask` as a number. */
const byte0ToNumber = (bytes: Uint8Array, mask: number): number => (bytes[0] ?? 0) & mask;

/**
 * Sign-extend a `bitWidth`-bit number into `destination` (8-byte little-endian).
 * `bitWidth` must be ≤ 32. For full XLEN values use byte arithmetic or
 * {@link bytesToBigInt}; JS `number` is not exact for all 64-bit integers.
 */
const signedNumberToBytes = (
  destination: Uint8Array,
  value: number,
  bitWidth: number
): Uint8Array => {
  const shift = 32 - bitWidth;
  let remaining = (value << shift) >> shift;
  for (let index = 0; index < 8; index += 1) {
    destination[index] = remaining & 0xff;
    remaining >>= 8;
  }
  return destination;
};

/**
 * Pack an unsigned 32-bit host value into `destination` (high bytes zero).
 * Inverse of {@link bytesToNumber} for instruction words and other u32 fields.
 */
const unsignedNumberToBytes = (destination: Uint8Array, value: number): Uint8Array => {
  const word = value >>> 0;
  destination[0] = word & 0xff;
  destination[1] = (word >>> 8) & 0xff;
  destination[2] = (word >>> 16) & 0xff;
  destination[3] = (word >>> 24) & 0xff;
  destination[4] = 0;
  destination[5] = 0;
  destination[6] = 0;
  destination[7] = 0;
  return destination;
};

/**
 * Sign-extend the low `byteLength` bytes already in `destination` to 64 bits in place.
 * Bytes at indices `byteLength`..7 are filled from the sign bit of byte `byteLength - 1`.
 */
const signExtendBytes = (destination: Uint8Array, byteLength: number): Uint8Array => {
  const signByte = ((destination[byteLength - 1] ?? 0) & 0x80) !== 0 ? 0xff : 0x00;
  for (let index = byteLength; index < 8; index += 1) {
    destination[index] = signByte;
  }
  return destination;
};

/**
 * Zero-extend the low `byteLength` bytes already in `destination` to 64 bits in place.
 * Bytes at indices `byteLength`..7 are cleared.
 */
const zeroExtendBytes = (destination: Uint8Array, byteLength: number): Uint8Array => {
  destination.fill(0, byteLength);
  return destination;
};

export {
  copyBytes,
  addBytes,
  subtractBytes,
  andBytes,
  orBytes,
  xorBytes,
  isZeroBytes,
  compareUnsignedBytes,
  compareSignedBytes,
  shiftLeftBytes,
  shiftRightLogicalBytes,
  shiftRightArithmeticBytes,
  low32Bytes,
  bytesToNumber,
  bytesToBigInt,
  byte0ToNumber,
  signedNumberToBytes,
  unsignedNumberToBytes,
  signExtendBytes,
  zeroExtendBytes,
};
