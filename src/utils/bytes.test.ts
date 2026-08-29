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
  bytesToNumber,
  compareSignedBytes,
  compareUnsignedBytes,
  copyBytes,
  low32Bytes,
  orBytes,
  shiftLeftBytes,
  shiftRightArithmeticBytes,
  shiftRightLogicalBytes,
  signExtendBytes,
  signExtendLow32Bytes,
  signedNumberToBytes,
  subtractBytes,
  xorBytes,
  zeroExtendBytes,
} from '#utils/bytes.js';

describe('utils/bytes', () => {
  it('copyBytes copies source into destination', () => {
    const destination = new Uint8Array(8);
    copyBytes(destination, signedNumberToBytes(0x1234, 32));
    assert.deepEqual(destination, signedNumberToBytes(0x1234, 32));
  });

  it('addBytes wraps at 64 bits', () => {
    const destination = new Uint8Array(8);
    addBytes(destination, signedNumberToBytes(-1, 32), signedNumberToBytes(1, 32));
    assert.deepEqual(destination, signedNumberToBytes(0, 32));
  });

  it('subtractBytes wraps at 64 bits', () => {
    const destination = new Uint8Array(8);
    subtractBytes(destination, signedNumberToBytes(0, 32), signedNumberToBytes(1, 32));
    assert.deepEqual(destination, signedNumberToBytes(-1, 32));
  });

  it('andBytes / orBytes / xorBytes operate bytewise', () => {
    const left = signedNumberToBytes(0x0f0f0f0f, 32);
    const right = signedNumberToBytes(0x00ff00ff, 32);
    const andResult = new Uint8Array(8);
    const orResult = new Uint8Array(8);
    const xorResult = new Uint8Array(8);
    andBytes(andResult, left, right);
    orBytes(orResult, left, right);
    xorBytes(xorResult, left, right);
    assert.deepEqual(andResult, signedNumberToBytes(0x000f000f, 32));
    assert.deepEqual(orResult, signedNumberToBytes(0x0fff0fff, 32));
    assert.deepEqual(xorResult, signedNumberToBytes(0x0ff00ff0, 32));
  });

  it('compareUnsignedBytes and compareSignedBytes disagree on high bit', () => {
    const negative = signedNumberToBytes(-1, 32);
    const positive = signedNumberToBytes(1, 32);
    assert.equal(compareUnsignedBytes(negative, positive), 1);
    assert.equal(compareSignedBytes(negative, positive), -1);
    assert.equal(compareUnsignedBytes(positive, positive), 0);
  });

  it('shiftLeftBytes and shiftRightLogicalBytes move bits', () => {
    const source = signedNumberToBytes(1, 32);
    const left = new Uint8Array(8);
    const right = new Uint8Array(8);
    shiftLeftBytes(left, source, 8);
    shiftRightLogicalBytes(right, left, 8);
    assert.deepEqual(left, signedNumberToBytes(0x100, 32));
    assert.deepEqual(right, signedNumberToBytes(1, 32));
  });

  it('shiftRightArithmeticBytes sign-fills', () => {
    const source = signedNumberToBytes(-256, 32);
    const destination = new Uint8Array(8);
    shiftRightArithmeticBytes(destination, source, 8);
    assert.deepEqual(destination, signedNumberToBytes(-1, 32));
  });

  it('signedNumberToBytes sign-extends narrow immediates', () => {
    assert.deepEqual(signedNumberToBytes(0x800, 12), signedNumberToBytes(-2048, 32));
    assert.deepEqual(signedNumberToBytes(1, 12), signedNumberToBytes(1, 32));
  });

  it('bytesToNumber and byte0ToNumber read little-endian lows', () => {
    const bytes = signedNumberToBytes(0x12345678, 32);
    assert.equal(bytesToNumber(bytes), 0x12345678);
    assert.equal(byte0ToNumber(bytes, 0xff), 0x78);
    assert.equal(byte0ToNumber(bytes, 0x3f), 0x38);
  });

  it('low32Bytes clears the high half', () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(low32Bytes(source), new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]));
  });

  it('signExtendBytes and zeroExtendBytes fill the high bytes', () => {
    const signed = new Uint8Array([0x80, 0, 0, 0, 0xaa, 0xaa, 0xaa, 0xaa]);
    signExtendBytes(signed, 1);
    assert.deepEqual(signed, new Uint8Array([0x80, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));

    const unsigned = new Uint8Array([0x80, 0, 0, 0, 0xaa, 0xaa, 0xaa, 0xaa]);
    zeroExtendBytes(unsigned, 1);
    assert.deepEqual(unsigned, new Uint8Array([0x80, 0, 0, 0, 0, 0, 0, 0]));
  });

  it('signExtendLow32Bytes copies and sign-extends the low word', () => {
    const destination = new Uint8Array(8);
    signExtendLow32Bytes(destination, signedNumberToBytes(0x80000000, 32));
    assert.deepEqual(destination, signedNumberToBytes(0x80000000, 32));
    assert.equal(destination[7], 0xff);
  });
});
