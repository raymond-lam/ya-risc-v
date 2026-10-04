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

import { bytesToNumber } from '#utils/bytes';
import decode32 from '#emulator/cpu/decode/decode-32';
import decodeC from '#emulator/cpu/decode/decode-c';
import { TWO_BYTES, FOUR_BYTES } from '#emulator/cpu/registers';
import type { Registers } from '#emulator/cpu/types';
import type { Memory } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';

type ExecuteThunk = (
  registers: Registers,
  memory: Memory,
  instructionByteLength: ReadonlyUint8Array
) => void | Promise<void>;

type DecodeResult = readonly [ExecuteThunk, ReadonlyUint8Array];

/**
 * Decode one RV64IMAC instruction into an execute thunk and its encoded width.
 *
 * Encodings with inst[1:0] ≠ 0b11 use the low halfword (RVC, length 2); otherwise
 * the full 32-bit word (length 4). The caller passes that length into the thunk for
 * PC fall-through and link values.
 */
const decode = (instructionWord: ReadonlyUint8Array): DecodeResult => {
  const encodedInstructionWord = bytesToNumber(instructionWord);

  // RVC: inst[1:0] ≠ 0b11 selects a 16-bit encoding in the low halfword.
  if ((encodedInstructionWord & 0x3) !== 0x3) {
    return [decodeC(encodedInstructionWord & 0xffff), TWO_BYTES];
  }

  return [decode32(encodedInstructionWord), FOUR_BYTES];
};

const thunkByInstructionWord = new Map<number, ExecuteThunk>();

/**
 * Like {@link decode}, but memoizes thunks by encoding.
 * 32-bit encodings key on the full word; RVC encodings key on the halfword so
 * identical compressed ops share a thunk regardless of the following halfword in the fetch.
 */
const decodeWithCache = (instructionWord: ReadonlyUint8Array): DecodeResult => {
  const encoded = bytesToNumber(instructionWord);
  // Fetch is always 4 bytes; for RVC only the low halfword is the insn (high half is PC+2).
  const isThirtyTwoBit = (encoded & 0x3) === 0x3;
  const instructionByteLength = isThirtyTwoBit ? FOUR_BYTES : TWO_BYTES;
  const key = isThirtyTwoBit ? encoded : encoded & 0xffff;
  if (thunkByInstructionWord.has(key)) {
    return [thunkByInstructionWord.get(key)!, instructionByteLength];
  }
  const [thunk] = decode(instructionWord);
  thunkByInstructionWord.set(key, thunk);
  return [thunk, instructionByteLength];
};

export default decodeWithCache;
