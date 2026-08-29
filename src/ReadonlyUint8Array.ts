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

/* eslint-disable no-restricted-syntax -- TypedArray subclass requires prototype methods */

/**
 * `Uint8Array` that can be initialized, but ignores later writes: index assignment,
 * `set`, `fill`, `copyWithin`, `reverse`, and `sort`. Mutation through a shared
 * `ArrayBuffer` or `DataView` still bypasses it.
 *
 * The `get` trap exists because TypedArray accessors and methods reject a Proxy as
 * `this`; it rebinds the receiver to the target rather than intercepting reads.
 */
class ReadonlyUint8Array extends Uint8Array {
  constructor(length?: number);
  constructor(array: ArrayLike<number>);
  constructor(buffer: ArrayBuffer, byteOffset?: number, length?: number);
  constructor(
    lengthOrArray?: number | ArrayLike<number> | ArrayBuffer,
    byteOffset?: number,
    length?: number
  ) {
    if (typeof lengthOrArray === 'number' || lengthOrArray === undefined) {
      super(lengthOrArray ?? 0);
    } else if (lengthOrArray instanceof ArrayBuffer) {
      super(lengthOrArray, byteOffset, length);
    } else {
      super(lengthOrArray);
    }

    return new Proxy(this, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value === 'function') {
          return (value as (...args: unknown[]) => unknown).bind(target);
        }
        return value;
      },
      set: () => true,
      defineProperty: () => true,
      deleteProperty: () => true,
    });
  }

  override set(_array: ArrayLike<number>, _offset?: number): void {
    /* no-op */
  }

  override fill(_value: number, _start?: number, _end?: number): this {
    return this;
  }

  override copyWithin(_target: number, _start: number, _end?: number): this {
    return this;
  }

  override reverse(): this {
    return this;
  }

  override sort(_compareFn?: ((a: number, b: number) => number) | undefined): this {
    return this;
  }

  /** Shared-buffer views would allow mutation; return a protected copy instead. */
  override subarray(begin?: number, end?: number): ReadonlyUint8Array {
    const start = begin ?? 0;
    const finish = end ?? this.length;
    return ReadonlyUint8Array.fromBytes(Array.from(this).slice(start, finish));
  }

  override slice(start?: number, end?: number): ReadonlyUint8Array {
    return ReadonlyUint8Array.fromBytes(Array.from(this).slice(start, end));
  }

  static fromBytes(arrayLike: ArrayLike<number>): ReadonlyUint8Array {
    return new ReadonlyUint8Array(arrayLike);
  }

  static ofBytes(...items: number[]): ReadonlyUint8Array {
    return new ReadonlyUint8Array(items);
  }
}

export default ReadonlyUint8Array;
