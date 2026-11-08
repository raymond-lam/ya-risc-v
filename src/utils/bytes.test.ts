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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addBytes,
  andBytes,
  byte0ToNumber,
  byteOfU32,
  byteOfU64,
  bytesToBigInt,
  bytesToBigInt64Array,
  bytesToBigUint64Array,
  bytesToAlignedBigUint64Array,
  signedBytesToBigInt,
  bytesToNumber,
  compareSignedBytes,
  compareUnsignedBytes,
  copyBytes,
  isZeroBytes,
  bytesToInt32Array,
  low32Bytes,
  orBytes,
  shiftLeftBytes,
  shiftRightArithmeticBytes,
  shiftRightLogicalBytes,
  signExtendBytes,
  signedNumberToBytes,
  subtractBytes,
  unsignedBigIntToBytes,
  unsignedNumberToBytes,
  xorBytes,
  zeroExtendBytes,
} from '#utils/bytes';

describe('utils/bytes', () => {
  it('copyBytes copies source into destination and returns it', () => {
    const destination = new Uint8Array(8);
    const result = copyBytes(destination, signedNumberToBytes(new Uint8Array(8), 0x1234, 32));
    assert.equal(result, destination);
    assert.deepEqual(destination, signedNumberToBytes(new Uint8Array(8), 0x1234, 32));
  });

  it('addBytes wraps at 64 bits and returns destination', () => {
    const destination = new Uint8Array(8);
    const result = addBytes(
      destination,
      signedNumberToBytes(new Uint8Array(8), -1, 32),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
    assert.equal(result, destination);
    assert.deepEqual(destination, signedNumberToBytes(new Uint8Array(8), 0, 32));
  });

  it('subtractBytes wraps at 64 bits and returns destination', () => {
    assert.deepEqual(
      subtractBytes(
        new Uint8Array(8),
        signedNumberToBytes(new Uint8Array(8), 0, 32),
        signedNumberToBytes(new Uint8Array(8), 1, 32)
      ),
      signedNumberToBytes(new Uint8Array(8), -1, 32)
    );
  });

  it('andBytes / orBytes / xorBytes operate bytewise and return destination', () => {
    const left = signedNumberToBytes(new Uint8Array(8), 0x0f0f0f0f, 32);
    const right = signedNumberToBytes(new Uint8Array(8), 0x00ff00ff, 32);
    assert.deepEqual(
      andBytes(new Uint8Array(8), left, right),
      signedNumberToBytes(new Uint8Array(8), 0x000f000f, 32)
    );
    assert.deepEqual(
      orBytes(new Uint8Array(8), left, right),
      signedNumberToBytes(new Uint8Array(8), 0x0fff0fff, 32)
    );
    assert.deepEqual(
      xorBytes(new Uint8Array(8), left, right),
      signedNumberToBytes(new Uint8Array(8), 0x0ff00ff0, 32)
    );
  });

  it('isZeroBytes is true only for all-zero bytes', () => {
    assert.equal(isZeroBytes(signedNumberToBytes(new Uint8Array(8), 0, 32)), true);
    assert.equal(isZeroBytes(signedNumberToBytes(new Uint8Array(8), 1, 32)), false);
  });

  it('compareUnsignedBytes and compareSignedBytes disagree on high bit', () => {
    const negative = signedNumberToBytes(new Uint8Array(8), -1, 32);
    const positive = signedNumberToBytes(new Uint8Array(8), 1, 32);
    assert.equal(compareUnsignedBytes(negative, positive), 1);
    assert.equal(compareSignedBytes(negative, positive), -1);
    assert.equal(compareUnsignedBytes(positive, positive), 0);
  });

  it('shiftLeftBytes and shiftRightLogicalBytes move bits and return destination', () => {
    const source = signedNumberToBytes(new Uint8Array(8), 1, 32);
    const left = shiftLeftBytes(new Uint8Array(8), source, 8);
    const right = shiftRightLogicalBytes(new Uint8Array(8), left, 8);
    assert.deepEqual(left, signedNumberToBytes(new Uint8Array(8), 0x100, 32));
    assert.deepEqual(right, signedNumberToBytes(new Uint8Array(8), 1, 32));
  });

  it('shiftRightArithmeticBytes sign-fills and returns destination', () => {
    assert.deepEqual(
      shiftRightArithmeticBytes(
        new Uint8Array(8),
        signedNumberToBytes(new Uint8Array(8), -256, 32),
        8
      ),
      signedNumberToBytes(new Uint8Array(8), -1, 32)
    );
  });

  it('signedNumberToBytes sign-extends narrow immediates', () => {
    assert.deepEqual(
      signedNumberToBytes(new Uint8Array(8), 0x800, 12),
      signedNumberToBytes(new Uint8Array(8), -2048, 32)
    );
    assert.deepEqual(
      signedNumberToBytes(new Uint8Array(8), 1, 12),
      signedNumberToBytes(new Uint8Array(8), 1, 32)
    );
  });

  it('bytesToNumber and byte0ToNumber read little-endian lows', () => {
    const bytes = signedNumberToBytes(new Uint8Array(8), 0x12345678, 32);
    assert.equal(bytesToNumber(bytes), 0x12345678);
    assert.equal(byte0ToNumber(bytes, 0xff), 0x78);
    assert.equal(byte0ToNumber(bytes, 0x3f), 0x38);
  });

  it('byteOfU32 and byteOfU64 extract a lane of a scalar, high lanes included', () => {
    assert.equal(byteOfU32(0x1234_5678, 0), 0x78);
    assert.equal(byteOfU32(0x1234_5678, 3), 0x12);
    assert.equal(byteOfU32(0xffff_ffff, 3), 0xff);
    // A u64 lane above bit 31 is unreachable through `number` shifting; only the bigint
    // form keeps it exact.
    assert.equal(byteOfU64(0x0102_0304_0506_0708n, 0), 0x08);
    assert.equal(byteOfU64(0x0102_0304_0506_0708n, 7), 0x01);
    assert.equal(byteOfU64(0xffff_ffff_ffff_ffffn, 5), 0xff);
  });

  it('unsignedNumberToBytes zero-extends a u32 (including when bit 31 is set)', () => {
    assert.deepEqual(
      unsignedNumberToBytes(new Uint8Array(8), 0x12345678),
      signedNumberToBytes(new Uint8Array(8), 0x12345678, 32)
    );
    assert.deepEqual(
      unsignedNumberToBytes(new Uint8Array(8), 0x80000000),
      new Uint8Array([0x00, 0x00, 0x00, 0x80, 0, 0, 0, 0])
    );
    assert.notDeepEqual(
      unsignedNumberToBytes(new Uint8Array(8), 0x80000000),
      signedNumberToBytes(new Uint8Array(8), 0x80000000, 32)
    );
  });

  it('unsignedBigIntToBytes packs a full little-endian u64', () => {
    assert.deepEqual(
      unsignedBigIntToBytes(new Uint8Array(8), 0x1000_0000n),
      new Uint8Array([0x00, 0x00, 0x00, 0x10, 0, 0, 0, 0])
    );
    assert.deepEqual(
      unsignedBigIntToBytes(new Uint8Array(8), 0x1_0000_0010n),
      new Uint8Array([0x10, 0, 0, 0, 1, 0, 0, 0])
    );
    assert.equal(
      bytesToBigInt(unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000n)),
      0x8000_0000n
    );
  });

  it('bytesToBigInt reads a full little-endian u64', () => {
    assert.equal(bytesToBigInt(signedNumberToBytes(new Uint8Array(8), 16, 32)), 16n);
    // 2^32 + 16
    assert.equal(bytesToBigInt(new Uint8Array([0x10, 0, 0, 0, 1, 0, 0, 0])), 0x1_0000_0010n);
  });

  it('signedBytesToBigInt reads two’s-complement i64', () => {
    assert.equal(signedBytesToBigInt(signedNumberToBytes(new Uint8Array(8), -1, 32)), -1n);
    assert.equal(
      signedBytesToBigInt(unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000_0000_0000n)),
      -0x8000_0000_0000_0000n
    );
  });

  it('low32Bytes clears the high half', () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(
      low32Bytes(new Uint8Array(8), source),
      new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])
    );
  });

  it('signExtendBytes and zeroExtendBytes fill the high bytes in place', () => {
    const signed = new Uint8Array([0x80, 0, 0, 0, 0xaa, 0xaa, 0xaa, 0xaa]);
    assert.equal(signExtendBytes(signed, 1), signed);
    assert.deepEqual(signed, new Uint8Array([0x80, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));

    const unsigned = new Uint8Array([0x80, 0, 0, 0, 0xaa, 0xaa, 0xaa, 0xaa]);
    assert.equal(zeroExtendBytes(unsigned, 1), unsigned);
    assert.deepEqual(unsigned, new Uint8Array([0x80, 0, 0, 0, 0, 0, 0, 0]));
  });

  it('signExtendBytes with byteLength 4 sign-extends a 32-bit word', () => {
    const destination = signExtendBytes(signedNumberToBytes(new Uint8Array(8), 0x80000000, 32), 4);
    assert.deepEqual(destination, signedNumberToBytes(new Uint8Array(8), 0x80000000, 32));
    assert.equal(destination[7], 0xff);
  });

  it('bytesToInt32Array returns an aligned Int32 view and rejects misalignment', () => {
    const bytes = new Uint8Array(8);
    const view = bytesToInt32Array(bytes, 4);
    view[0] = 0x12345678;
    assert.equal(bytes[4], 0x78);
    assert.equal(bytes[5], 0x56);
    assert.equal(bytes[6], 0x34);
    assert.equal(bytes[7], 0x12);
    assert.throws(() => bytesToInt32Array(bytes, 1), /4-byte aligned/);
  });

  it('bytesToBigInt64Array returns an aligned BigInt64 view and rejects misalignment', () => {
    const bytes = new Uint8Array(16);
    const view = bytesToBigInt64Array(bytes, 8);
    view[0] = 0x0102_0304_0506_0708n;
    assert.deepEqual(
      bytes.slice(8, 16),
      Uint8Array.of(0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01)
    );
    assert.throws(() => bytesToBigInt64Array(bytes, 4), /8-byte aligned/);
  });

  it('bytesToBigUint64Array returns an aligned BigUint64 view and rejects misalignment', () => {
    const bytes = new Uint8Array(16);
    const view = bytesToBigUint64Array(bytes, 8);
    view[0] = 0x8000_0000_0000_0001n;
    assert.deepEqual(bytes.slice(8, 16), Uint8Array.of(0x01, 0, 0, 0, 0, 0, 0, 0x80));
    assert.throws(() => bytesToBigUint64Array(bytes, 4), /8-byte aligned/);
  });

  it('bytesToAlignedBigUint64Array views the buffer-aligned word encompassing a byte', () => {
    const buffer = new ArrayBuffer(24);
    const slice = new Uint8Array(buffer, 3, 18); // unaligned byteOffset
    const [view, byteIndex] = bytesToAlignedBigUint64Array(slice, 2); // absolute byte 5
    assert.equal(view.length, 1);
    assert.equal(view.byteOffset, 0);
    assert.equal(view.buffer, buffer);
    assert.equal(byteIndex, 5);
    view[0] = 0x0807_0605_0403_0201n;
    assert.equal(slice[2], 0x06);
    assert.equal(slice[0], 0x04);
    slice[2] = 0xee;
    assert.equal(view[0], 0x0807_ee05_0403_0201n);

    const [nextView, nextByteIndex] = bytesToAlignedBigUint64Array(slice, 5); // absolute byte 8
    assert.equal(nextView.byteOffset, 8);
    assert.equal(nextByteIndex, 0);
    const [lastView, lastByteIndex] = bytesToAlignedBigUint64Array(slice, 4); // absolute byte 7
    assert.equal(lastView.byteOffset, 0);
    assert.equal(lastByteIndex, 7);
  });

  it('bytesToAlignedBigUint64Array rejects bad indexes and words past the buffer end', () => {
    const slice = new Uint8Array(new ArrayBuffer(24), 3, 18);
    for (const index of [-1, 18, 1.5, Number.NaN]) {
      assert.throws(() => bytesToAlignedBigUint64Array(slice, index), /byte inside bytes/);
    }
    const unpadded = new Uint8Array(new ArrayBuffer(12));
    assert.equal(bytesToAlignedBigUint64Array(unpadded, 7)[1], 7);
    assert.throws(() => bytesToAlignedBigUint64Array(unpadded, 8), /fit in the underlying/);
  });
});
