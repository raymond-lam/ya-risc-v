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
import { rangesOverlap } from '#utils/ranges';

describe('rangesOverlap', () => {
  it('detects overlapping half-open ranges', () => {
    assert.equal(rangesOverlap(0n, 8n, 4n, 8n), true);
    assert.equal(rangesOverlap(0n, 8n, 8n, 8n), false);
    assert.equal(rangesOverlap(10n, 5n, 0n, 10n), false);
    assert.equal(rangesOverlap(10n, 5n, 0n, 11n), true);
  });

  it('treats empty ranges as non-overlapping', () => {
    assert.equal(rangesOverlap(0n, 0n, 0n, 8n), false);
    assert.equal(rangesOverlap(0n, 8n, 4n, 0n), false);
  });
});
