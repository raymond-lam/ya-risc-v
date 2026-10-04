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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useInput } from 'ink';
import {
  createVt100Terminal,
  encodeKey,
  serializeVt100Viewport,
  writeVt100Output,
} from '#utils/tty';
import type { DOMElement } from 'ink';
import type { RefObject } from 'react';
import type { Readable, Writable } from 'node:stream';
import type { Terminal as XTerminal } from '@xterm/headless';
import type { Vt100Line } from '#utils/tty';

type TerminalProps = {
  /** Keystrokes while focused are written here as VT100 wire bytes (guest stdin). */
  stdin: Writable;
  /** Guest UART TX bytes (VT100) painted via a headless xterm viewport. */
  stdout: Readable;
  /** When true, keystrokes go to the guest and the border is highlighted. */
  focused: boolean;
  /** Host layout box for hit-testing clicks. */
  boxRef: RefObject<DOMElement | null>;
  /** Host TTY columns; remounts layout measure when the window resizes. */
  columns: number;
  /** Host TTY rows; remounts layout measure when the window resizes. */
  rows: number;
};

/** Border (2) + horizontal padding (2) from the pane chrome. */
const PANE_CHROME_COLS = 4;
/** Single-line border top + bottom. */
const PANE_CHROME_ROWS = 2;

const emptyViewport = (): Vt100Line[] => [[{ text: ' ', style: {} }]];

const Terminal = ({ stdin, stdout, focused, boxRef, columns, rows }: TerminalProps) => {
  const paneRef = useRef<DOMElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const paintChainRef = useRef(Promise.resolve());
  const [lines, setLines] = useState<Vt100Line[]>(emptyViewport);
  const [size, setSize] = useState({ cols: 80, rows: 24 });

  useLayoutEffect(() => {
    const node = paneRef.current;
    if (node === null) {
      return;
    }
    const measured = measureElement(node);
    const cols = Math.max(2, measured.width - PANE_CHROME_COLS);
    const nextRows = Math.max(1, measured.height - PANE_CHROME_ROWS);
    setSize((previous) =>
      previous.cols === cols && previous.rows === nextRows ? previous : { cols, rows: nextRows }
    );
  }, [columns, rows]);

  useEffect(() => {
    const terminal = createVt100Terminal(80, 24);
    termRef.current = terminal;
    paintChainRef.current = Promise.resolve();

    // Serialize xterm write + snapshot so concurrent stdout chunks cannot paint out of order.
    const onStdout = (chunk: string | Buffer): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      paintChainRef.current = paintChainRef.current
        .then(async () => {
          const active = termRef.current;
          if (active === null) {
            return;
          }
          await writeVt100Output(active, bytes);
          if (termRef.current === active) {
            setLines(serializeVt100Viewport(active));
          }
        })
        .catch(() => {
          // Keep the chain alive if a write rejects so later chunks still paint.
        });
    };
    stdout.on('data', onStdout);

    return () => {
      stdout.off('data', onStdout);
      termRef.current = null;
      terminal.dispose();
    };
  }, [stdout]);

  useEffect(() => {
    const terminal = termRef.current;
    if (terminal === null) {
      return;
    }
    if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
      terminal.resize(size.cols, size.rows);
    }
    setLines(serializeVt100Viewport(terminal));
  }, [size.cols, size.rows]);

  useInput(
    (value, key) => {
      const encoded = encodeKey(value, key);
      if (encoded.byteLength === 0) {
        return;
      }
      stdin.write(Buffer.from(encoded));
    },
    { isActive: focused }
  );

  const setPaneRef = (node: DOMElement | null): void => {
    paneRef.current = node;
    boxRef.current = node;
  };

  return (
    <Box
      ref={setPaneRef}
      flexGrow={1}
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? 'green' : 'gray'}
      paddingX={1}
      overflowY="hidden"
    >
      {lines.map((line, row) => (
        <Text key={row}>
          {line.map((span, index) => (
            <Text key={index} {...span.style}>
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
};

export default Terminal;
