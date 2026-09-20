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

/* eslint-disable import/prefer-default-export -- shared architectural types */

/**
 * Byte buffer used only for reading. Plain `Uint8Array` values are assignable;
 * writes through this type are a type error. Type-level only — no runtime Proxy.
 */
type ReadonlyUint8Array = {
  readonly length: number;
  readonly [index: number]: number;
  [Symbol.iterator](): IterableIterator<number>;
};

export type { ReadonlyUint8Array };
