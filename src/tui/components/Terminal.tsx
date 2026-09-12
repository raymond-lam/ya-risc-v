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

import { useEffect, useRef, useState } from 'react';
import { Box, Text, useFocus, useInput } from 'ink';
import { applyTerminalOutput, encodeKey } from '#utils/tty';
import type { Readable, Writable } from 'node:stream';

type TerminalProps = {
  /** Keystrokes while focused are written here (guest stdin). */
  stdin: Writable;
  /** Bytes read here are painted in the pane (guest stdout). */
  stdout: Readable;
};

const Terminal = ({ stdin, stdout }: TerminalProps) => {
  const { isFocused } = useFocus({ autoFocus: true, id: 'terminal' });
  const [text, setText] = useState('');
  const decoderRef = useRef(new TextDecoder('utf-8', { fatal: false }));

  useEffect(() => {
    const decoder = decoderRef.current;
    const onData = (chunk: string | Buffer): void => {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      const decoded = decoder.decode(bytes, { stream: true });
      setText((previous) => applyTerminalOutput(previous, decoded));
    };
    stdout.on('data', onData);
    return () => {
      stdout.off('data', onData);
    };
  }, [stdout]);

  useInput(
    (value, key) => {
      const encoded = encodeKey(value, key);
      if (encoded.byteLength === 0) {
        return;
      }
      stdin.write(Buffer.from(encoded));
    },
    { isActive: isFocused }
  );

  return (
    <Box
      flexGrow={1}
      flexDirection="column"
      borderStyle="single"
      borderColor={isFocused ? 'green' : 'gray'}
      paddingX={1}
      overflowY="hidden"
    >
      <Text>{text}</Text>
    </Box>
  );
};

export default Terminal;
export type { TerminalProps };
