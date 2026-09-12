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

import type { Key } from 'ink';

const EMPTY = new Uint8Array(0);

/** Host-only mouse reports (SGR / X10); never forwarded to the guest UART. */
const isHostMouseReport = (input: string, key: Key): boolean => {
  if (input.includes('\x1b[<') || input.startsWith('\x1b[M')) {
    return true;
  }
  // Ink often splits ESC into `key.escape` and leaves the CSI body in `input`.
  return key.escape && (input.startsWith('[<') || input.startsWith('[M'));
};

/** Ink boolean key flags that map to a fixed wire byte sequence (not text). */
const SPECIAL_SEQUENCES: ReadonlyArray<readonly [keyof Key, Uint8Array]> = [
  ['return', Uint8Array.of(0x0d)],
  ['escape', Uint8Array.of(0x1b)],
  ['tab', Uint8Array.of(0x09)],
  ['backspace', Uint8Array.of(0x7f)],
  ['delete', Uint8Array.of(0x1b, 0x5b, 0x33, 0x7e)], // CSI 3 ~
  ['upArrow', Uint8Array.of(0x1b, 0x5b, 0x41)], // CSI A
  ['downArrow', Uint8Array.of(0x1b, 0x5b, 0x42)],
  ['rightArrow', Uint8Array.of(0x1b, 0x5b, 0x43)],
  ['leftArrow', Uint8Array.of(0x1b, 0x5b, 0x44)],
  ['home', Uint8Array.of(0x1b, 0x5b, 0x48)],
  ['end', Uint8Array.of(0x1b, 0x5b, 0x46)],
  ['pageUp', Uint8Array.of(0x1b, 0x5b, 0x35, 0x7e)], // CSI 5 ~
  ['pageDown', Uint8Array.of(0x1b, 0x5b, 0x36, 0x7e)],
];

const encodeCtrlLetter = (input: string): Uint8Array | null => {
  if (input.length !== 1) {
    return null;
  }
  const code = input.toLowerCase().charCodeAt(0);
  if (code < 0x61 || code > 0x7a) {
    return null;
  }
  return Uint8Array.of(code - 0x60);
};

/**
 * ASCII (and DEL) as one octet per code unit — what a raw TTY sends for those keys.
 * Non-ASCII Unicode from Ink is encoded the same way a UTF-8 host console would
 * put that text on the wire (TextEncoder); that is text encoding, not "keys are UTF-8".
 */
const textToWireBytes = (input: string): Uint8Array => {
  let asciiOnly = true;
  for (let index = 0; index < input.length; index += 1) {
    if ((input.charCodeAt(index) & 0xff80) !== 0) {
      asciiOnly = false;
      break;
    }
  }
  if (asciiOnly) {
    const bytes = new Uint8Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      bytes[index] = input.charCodeAt(index);
    }
    return bytes;
  }
  return new TextEncoder().encode(input);
};

/**
 * Map an Ink `useInput` event to UART wire octets: fixed sequences for controls /
 * CSI keys, control bytes for Ctrl+letter, host mouse filtered out, text as above.
 */
const encodeKey = (input: string, key: Key): Uint8Array => {
  if (isHostMouseReport(input, key)) {
    return EMPTY;
  }
  for (const [flag, sequence] of SPECIAL_SEQUENCES) {
    if (key[flag] === true) {
      return sequence;
    }
  }
  if (key.ctrl) {
    return encodeCtrlLetter(input) ?? textToWireBytes(input);
  }
  if (input.length === 0) {
    return EMPTY;
  }
  return textToWireBytes(input);
};

/**
 * Apply a decoded stdout fragment to a glass-TTY style buffer: CR returns to the
 * start of the line, BS erases the previous cell, BEL is ignored, otherwise append.
 */
const applyTerminalOutput = (previous: string, decoded: string): string => {
  let next = previous;
  for (const character of decoded) {
    if (character === '\r') {
      const lineStart = next.lastIndexOf('\n') + 1;
      next = next.slice(0, lineStart);
      continue;
    }
    if (character === '\b') {
      if (next.length > 0 && next.at(-1) !== '\n') {
        next = next.slice(0, -1);
      }
      continue;
    }
    if (character === '\x07') {
      continue;
    }
    next += character;
  }
  return next;
};

export { applyTerminalOutput, encodeKey };
