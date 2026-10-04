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
import { bigIntAsNumber } from '#utils/int';

describe('bigIntAsNumber', () => {
  it('converts values in the safe integer range', () => {
    assert.equal(bigIntAsNumber(0n), 0);
    assert.equal(bigIntAsNumber(42n), 42);
    assert.equal(bigIntAsNumber(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  });

  it('rejects negative and oversized values', () => {
    assert.throws(() => bigIntAsNumber(-1n), RangeError);
    assert.throws(() => bigIntAsNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n), RangeError);
  });
});
