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

import { useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import useMouseLeftClick from '#tui/hooks/use-mouse-left-click';
import Terminal from '#tui/components/Terminal';
import type { DOMElement } from 'ink';
import type { Readable, Writable } from 'node:stream';

type AppProps = {
  /** Keystrokes from the focused terminal. */
  stdin: Writable;
  /** Bytes painted in the terminal pane. */
  stdout: Readable;
  /** Invoked when the user clicks Shutdown. */
  onShutdown: () => void;
};

const App = ({ stdin, stdout, onShutdown }: AppProps) => {
  const { columns, rows } = useWindowSize();
  const terminalRef = useRef<DOMElement>(null);
  const shutdownRef = useRef<DOMElement>(null);
  const [terminalFocused, setTerminalFocused] = useState(true);

  useMouseLeftClick(
    [
      { target: shutdownRef, onClick: onShutdown },
      { target: terminalRef, onClick: () => setTerminalFocused(true) },
    ],
    () => {
      setTerminalFocused(false);
    }
  );

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Terminal stdin={stdin} stdout={stdout} focused={terminalFocused} boxRef={terminalRef} />
      <Box width="100%" backgroundColor="blue">
        <Box ref={shutdownRef} paddingX={1}>
          <Text color="white" backgroundColor="blue">
            Shutdown
          </Text>
        </Box>
      </Box>
    </Box>
  );
};

export default App;
export type { AppProps };
