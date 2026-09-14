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
import {
  createVt100Terminal,
  encodeKey,
  serializeVt100Viewport,
  writeVt100Output,
} from '#utils/tty';
import type { Key } from 'ink';

const key = (overrides: Partial<Key> = {}): Key =>
  ({
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  }) as Key;

const lineText = (spans: readonly { text: string }[]): string =>
  spans
    .map((span) => span.text)
    .join('')
    .trimEnd();

describe('encodeKey', () => {
  it('encodes printable ASCII and CSI specials as VT100 wire bytes', () => {
    assert.deepEqual(encodeKey('A', key()), Uint8Array.of(0x41));
    assert.deepEqual(encodeKey('', key({ return: true })), Uint8Array.of(0x0d));
    assert.deepEqual(encodeKey('', key({ upArrow: true })), Uint8Array.of(0x1b, 0x5b, 0x41));
  });

  it('drops host mouse reports', () => {
    assert.equal(encodeKey('\x1b[<0;1;1M', key()).byteLength, 0);
    assert.equal(encodeKey('[<0;1;1M', key()).byteLength, 0);
    assert.equal(encodeKey('[<0;1;1m', key()).byteLength, 0);
    assert.equal(encodeKey('[<0;1;1M', key({ escape: true })).byteLength, 0);
    assert.equal(encodeKey('\x1b[M !', key()).byteLength, 0);
    assert.equal(encodeKey('[M !', key()).byteLength, 0);
  });
});

describe('vt100 terminal viewport', () => {
  it('applies cursor motion, SGR color, and erase', async () => {
    const terminal = createVt100Terminal(20, 4);
    try {
      await writeVt100Output(
        terminal,
        '\x1b[2J\x1b[H\x1b[31mHi\x1b[0m\r\nBye\x1b[1;1H\x1b[2K\x1b[32mOk\x1b[0m'
      );
      const lines = serializeVt100Viewport(terminal);
      assert.equal(lineText(lines[0] ?? []), 'Ok');
      assert.equal(lineText(lines[1] ?? []), 'Bye');
      assert.equal(lines[0]?.[0]?.style.color, 'green');
    } finally {
      terminal.dispose();
    }
  });

  it('emits DA replies on the input path as VT100 sequences', async () => {
    const terminal = createVt100Terminal(20, 4);
    const replies: string[] = [];
    const disposable = terminal.onData((data) => {
      replies.push(data);
    });
    try {
      await writeVt100Output(terminal, '\x1b[c');
      assert.ok(replies.some((reply) => reply.startsWith('\x1b[?')));
    } finally {
      disposable.dispose();
      terminal.dispose();
    }
  });
});
