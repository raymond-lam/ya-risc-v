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

/* eslint-disable import/prefer-default-export -- named export matches call-site style */

/** Half-open guest or host range `[base, base + size)` with a label for diagnostics. */
type NamedRange = {
  name: string;
  base: bigint;
  size: bigint;
};

/**
 * True when half-open ranges `[aBase, aBase + aSize)` and `[bBase, bBase + bSize)`
 * overlap. Empty ranges (size ≤ 0) never overlap.
 */
const rangesOverlap = (aBase: bigint, aSize: bigint, bBase: bigint, bSize: bigint): boolean =>
  aSize > 0n && bSize > 0n && aBase < bBase + bSize && bBase < aBase + aSize;

/**
 * First overlapping pair among `ranges` (order preserved: earlier index is `a`),
 * or `null` if none overlap.
 */
const findOverlappingPair = (
  ranges: readonly NamedRange[]
): { a: NamedRange; b: NamedRange } | null => {
  for (let index = 0; index < ranges.length; index += 1) {
    const a = ranges[index];
    if (a === undefined) {
      continue;
    }
    for (let other = index + 1; other < ranges.length; other += 1) {
      const b = ranges[other];
      if (b === undefined) {
        continue;
      }
      if (rangesOverlap(a.base, a.size, b.base, b.size)) {
        return { a, b };
      }
    }
  }
  return null;
};

export { findOverlappingPair };
