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

/**
 * True when half-open ranges `[aBase, aBase + aSize)` and `[bBase, bBase + bSize)`
 * overlap. Empty ranges (size ≤ 0) never overlap.
 */
const rangesOverlap = (aBase: bigint, aSize: bigint, bBase: bigint, bSize: bigint): boolean =>
  aSize > 0n && bSize > 0n && aBase < bBase + bSize && bBase < aBase + aSize;

export { rangesOverlap };
