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
import { findOverlappingPair } from '#utils/ranges';

describe('findOverlappingPair', () => {
  it('returns null when no ranges overlap', () => {
    assert.equal(
      findOverlappingPair([
        { name: 'a', base: 0n, size: 8n },
        { name: 'b', base: 8n, size: 8n },
        { name: 'c', base: 16n, size: 8n },
      ]),
      null
    );
  });

  it('treats abutting and empty ranges as non-overlapping', () => {
    assert.equal(
      findOverlappingPair([
        { name: 'a', base: 0n, size: 8n },
        { name: 'b', base: 8n, size: 8n },
      ]),
      null
    );
    assert.equal(
      findOverlappingPair([
        { name: 'a', base: 0n, size: 0n },
        { name: 'b', base: 0n, size: 8n },
      ]),
      null
    );
  });

  it('returns the first overlapping pair in list order', () => {
    assert.deepEqual(
      findOverlappingPair([
        { name: 'uart', base: 0x1000n, size: 8n },
        { name: 'clint', base: 0x2000n, size: 0xc000n },
        { name: 'ram', base: 0x8000n, size: 0x1000n },
      ]),
      {
        a: { name: 'clint', base: 0x2000n, size: 0xc000n },
        b: { name: 'ram', base: 0x8000n, size: 0x1000n },
      }
    );
  });
});
