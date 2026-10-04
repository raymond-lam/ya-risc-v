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
import findLastIndex from '#utils/binary-search';

describe('findLastIndex', () => {
  it('returns -1 for an empty array', () => {
    assert.equal(
      findLastIndex([], () => true),
      -1
    );
  });

  it('returns -1 when every element is false', () => {
    assert.equal(
      findLastIndex([1, 2, 3], (value) => value < 0),
      -1
    );
  });

  it('returns the last index when every element is true', () => {
    assert.equal(
      findLastIndex([1, 2, 3], () => true),
      2
    );
  });

  it('finds the rightmost true in a true…false partition', () => {
    const values = [1, 3, 5, 7, 9];
    assert.equal(
      findLastIndex(values, (value) => value <= 5),
      2
    );
    assert.equal(
      findLastIndex(values, (value) => value <= 1),
      0
    );
    assert.equal(
      findLastIndex(values, (value) => value <= 9),
      4
    );
    assert.equal(
      findLastIndex(values, (value) => value <= 6),
      2
    );
  });
});
