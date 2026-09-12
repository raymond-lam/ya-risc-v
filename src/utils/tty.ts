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

import { createRequire } from 'node:module';
import type { Key } from 'ink';
import type {
  IBufferCell,
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  Terminal as XTerminal,
} from '@xterm/headless';

const require = createRequire(import.meta.url);
const { Terminal: XTerm } = require('@xterm/headless') as {
  Terminal: new (options?: ITerminalOptions & ITerminalInitOnlyOptions) => XTerminal;
};

const EMPTY = new Uint8Array(0);

/** Ink / chalk 16-color names matching xterm's default ANSI palette. */
const ANSI16 = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
] as const;

type Vt100Style = {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  color?: string;
  backgroundColor?: string;
};

type Vt100Span = {
  text: string;
  style: Vt100Style;
};

type Vt100Line = readonly Vt100Span[];

/** Host-only mouse reports (SGR / X10); never forwarded to the guest UART. */
const isHostMouseReport = (input: string): boolean =>
  // Full sequences, or Ink's form after it strips the leading ESC from `sequence`.
  input.includes('\x1b[<') ||
  input.includes('\x1b[M') ||
  input.startsWith('[<') ||
  input.startsWith('[M');

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
  if (isHostMouseReport(input)) {
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

const toHexByte = (value: number): string => value.toString(16).padStart(2, '0');

const rgbToHex = (rgb: number): string =>
  `#${toHexByte((rgb >>> 16) & 0xff)}${toHexByte((rgb >>> 8) & 0xff)}${toHexByte(rgb & 0xff)}`;

const color256ToHex = (index: number): string => {
  if (index < 16) {
    return ANSI16[index] ?? 'white';
  }
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    const hex = toHexByte(level);
    return `#${hex}${hex}${hex}`;
  }
  const cube = index - 16;
  const r = Math.floor(cube / 36);
  const g = Math.floor((cube % 36) / 6);
  const b = cube % 6;
  const level = (channel: number): number => (channel === 0 ? 0 : 55 + channel * 40);
  return `#${toHexByte(level(r))}${toHexByte(level(g))}${toHexByte(level(b))}`;
};

const cellColor = (
  isDefault: boolean,
  isPalette: boolean,
  isRgb: boolean,
  value: number
): string | undefined => {
  if (isDefault) {
    return undefined;
  }
  if (isRgb) {
    return rgbToHex(value);
  }
  if (isPalette) {
    if (value >= 0 && value < 16) {
      return ANSI16[value];
    }
    if (value >= 0 && value < 256) {
      return color256ToHex(value);
    }
  }
  return undefined;
};

const stylesEqual = (left: Vt100Style, right: Vt100Style): boolean =>
  left.bold === right.bold &&
  left.dim === right.dim &&
  left.italic === right.italic &&
  left.underline === right.underline &&
  left.inverse === right.inverse &&
  left.color === right.color &&
  left.backgroundColor === right.backgroundColor;

const styleFromCell = (cell: IBufferCell): Vt100Style => {
  if (cell.isInvisible()) {
    return {};
  }
  const style: Vt100Style = {};
  if (cell.isBold()) {
    style.bold = true;
  }
  if (cell.isDim()) {
    style.dim = true;
  }
  if (cell.isItalic()) {
    style.italic = true;
  }
  if (cell.isUnderline()) {
    style.underline = true;
  }
  if (cell.isInverse()) {
    style.inverse = true;
  }
  const color = cellColor(
    cell.isFgDefault(),
    cell.isFgPalette(),
    cell.isFgRGB(),
    cell.getFgColor()
  );
  if (color !== undefined) {
    style.color = color;
  }
  const backgroundColor = cellColor(
    cell.isBgDefault(),
    cell.isBgPalette(),
    cell.isBgRGB(),
    cell.getBgColor()
  );
  if (backgroundColor !== undefined) {
    style.backgroundColor = backgroundColor;
  }
  return style;
};

/**
 * Headless xterm instance that parses guest UART TX as VT100 and exposes a
 * viewport buffer for the Ink terminal pane.
 */
const createVt100Terminal = (cols: number, rows: number): XTerminal =>
  new XTerm({
    allowProposedApi: true,
    cols: Math.max(2, cols),
    rows: Math.max(1, rows),
    // UART has no termios ONLCR; guests that want CR+LF send both.
    convertEol: false,
    logLevel: 'off',
    scrollback: 1000,
  });

const writeVt100Output = (terminal: XTerminal, data: string | Uint8Array): Promise<void> =>
  new Promise((resolve) => {
    terminal.write(data, resolve);
  });

const cellGlyph = (cell: IBufferCell): string => {
  if (cell.isInvisible()) {
    return ' '.repeat(Math.max(1, cell.getWidth()));
  }
  const chars = cell.getChars();
  return chars.length === 0 ? ' ' : chars;
};

const serializeVt100Line = (
  line: ReturnType<XTerminal['buffer']['active']['getLine']>,
  cols: number,
  reusable: IBufferCell
): Vt100Line => {
  if (line === undefined) {
    return [{ text: ' '.repeat(cols), style: {} }];
  }

  const spans: Vt100Span[] = [];
  let currentText = '';
  let currentStyle: Vt100Style = {};

  const flush = (): void => {
    if (currentText.length === 0) {
      return;
    }
    spans.push({ text: currentText, style: currentStyle });
    currentText = '';
  };

  for (let col = 0; col < cols; col += 1) {
    const cell = line.getCell(col, reusable);
    if (cell === undefined || cell.getWidth() === 0) {
      continue;
    }
    const glyph = cellGlyph(cell);
    const style = styleFromCell(cell);
    if (currentText.length === 0 || !stylesEqual(currentStyle, style)) {
      flush();
      currentText = glyph;
      currentStyle = style;
      continue;
    }
    currentText += glyph;
  }
  flush();
  return spans.length === 0 ? [{ text: ' ', style: {} }] : spans;
};

/** Flatten the active viewport into Ink-friendly styled spans (one array per row). */
const serializeVt100Viewport = (terminal: XTerminal): Vt100Line[] => {
  const { cols, rows } = terminal;
  const buffer = terminal.buffer.active;
  const reusable = buffer.getNullCell();
  const lines: Vt100Line[] = [];
  for (let row = 0; row < rows; row += 1) {
    lines.push(serializeVt100Line(buffer.getLine(row), cols, reusable));
  }
  return lines;
};
export { createVt100Terminal, encodeKey, serializeVt100Viewport, writeVt100Output };
export type { Vt100Line };
