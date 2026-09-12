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

import { useEffect, useRef } from 'react';
import { measureElement, useStdin, useStdout } from 'ink';
import type { RefObject } from 'react';
import type { DOMElement } from 'ink';

/** Press/release tracking + SGR coordinates (1-based columns/rows from the host TTY). */
const ENABLE_MOUSE_TRACKING = '\u001b[?1000h\u001b[?1006h';
const DISABLE_MOUSE_TRACKING = '\u001b[?1006l\u001b[?1000l';

type MouseClick = {
  /** 0-based host TTY column. */
  column: number;
  /** 0-based host TTY row. */
  row: number;
};

type BoxBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const SGR_LEFT_PRESS = /\u001b\[<0;(\d+);(\d+)M/g;
const X10_LEFT_PRESS_PREFIX = '\u001b[M\u0020';

const parseSgrLeftClicks = (input: string, clicks: MouseClick[]): void => {
  SGR_LEFT_PRESS.lastIndex = 0;
  for (const match of input.matchAll(SGR_LEFT_PRESS)) {
    const column = Number(match[1]);
    const row = Number(match[2]);
    clicks.push({ column: column - 1, row: row - 1 });
  }
};

const parseX10LeftClicks = (input: string, clicks: MouseClick[]): void => {
  let searchFrom = 0;
  while (searchFrom < input.length) {
    const prefixAt = input.indexOf(X10_LEFT_PRESS_PREFIX, searchFrom);
    if (prefixAt === -1) {
      return;
    }
    const xCode = input.charCodeAt(prefixAt + X10_LEFT_PRESS_PREFIX.length);
    const yCode = input.charCodeAt(prefixAt + X10_LEFT_PRESS_PREFIX.length + 1);
    if (Number.isNaN(xCode) || Number.isNaN(yCode)) {
      return;
    }
    clicks.push({ column: xCode - 33, row: yCode - 33 });
    searchFrom = prefixAt + X10_LEFT_PRESS_PREFIX.length + 2;
  }
};

/** Left-button presses only; SGR (`ESC[<0;x;yM`) and X10 (`ESC[M` + three bytes). */
const parseMouseClicks = (input: string): MouseClick[] => {
  const clicks: MouseClick[] = [];
  parseSgrLeftClicks(input, clicks);
  parseX10LeftClicks(input, clicks);
  return clicks;
};

const containsPoint = (box: BoxBounds, column: number, row: number): boolean =>
  column >= box.x && column < box.x + box.width && row >= box.y && row < box.y + box.height;

const useClick = (target: RefObject<DOMElement | null>, onClick: () => void): void => {
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  useEffect(() => {
    if (!isRawModeSupported) {
      return undefined;
    }
    setRawMode(true);
    stdout.write(ENABLE_MOUSE_TRACKING);
    const onData = (chunk: string | Buffer): void => {
      const node = target.current;
      if (node === null) {
        return;
      }
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const box = measureElement(node);
      for (const click of parseMouseClicks(text)) {
        if (containsPoint(box, click.column, click.row)) {
          onClickRef.current();
          return;
        }
      }
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      stdout.write(DISABLE_MOUSE_TRACKING);
      setRawMode(false);
    };
  }, [isRawModeSupported, setRawMode, stdin, stdout, target]);
};

export default useClick;
