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
import ReadonlyUint8Array from '#ReadonlyUint8Array.js';

describe('ReadonlyUint8Array', () => {
  it('preserves initialized values', () => {
    const bytes = ReadonlyUint8Array.ofBytes(1, 2, 3, 4);
    assert.deepEqual([...bytes], [1, 2, 3, 4]);
  });

  it('ignores index writes', () => {
    const bytes = ReadonlyUint8Array.ofBytes(1, 2, 3, 4);
    bytes[0] = 99;
    assert.equal(bytes[0], 1);
  });

  it('ignores set, fill, and copyWithin', () => {
    const bytes = ReadonlyUint8Array.ofBytes(1, 2, 3, 4);
    bytes.set([9, 9]);
    bytes.fill(7);
    bytes.copyWithin(0, 2);
    assert.deepEqual([...bytes], [1, 2, 3, 4]);
  });

  it('subarray returns a protected copy', () => {
    const bytes = ReadonlyUint8Array.ofBytes(1, 2, 3, 4);
    const view = bytes.subarray(1, 3);
    view[0] = 99;
    assert.equal(bytes[1], 2);
    assert.equal(view[0], 2);
  });
});
