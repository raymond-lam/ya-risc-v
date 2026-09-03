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
  bytesToBigInt,
  bytesToNumber,
  compareSignedBytes,
  compareUnsignedBytes,
  copyBytes,
  isZeroBytes,
  low32Bytes,
  orBytes,
  shiftLeftBytes,
  shiftRightArithmeticBytes,
  shiftRightLogicalBytes,
  signExtendBytes,
  signedNumberToBytes,
  subtractBytes,
  unsignedNumberToBytes,
  xorBytes,
  zeroExtendBytes,
} from '#utils/bytes.js';

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

  it('bytesToBigInt reads a full little-endian u64', () => {
    assert.equal(bytesToBigInt(signedNumberToBytes(new Uint8Array(8), 16, 32)), 16n);
    // 2^32 + 16
    assert.equal(bytesToBigInt(new Uint8Array([0x10, 0, 0, 0, 1, 0, 0, 0])), 0x1_0000_0010n);
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
});
