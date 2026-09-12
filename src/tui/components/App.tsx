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

import { useRef } from 'react';
import { Box, Text, useApp, useWindowSize } from 'ink';
import useClick from '#tui/hooks/use-click';
import Terminal from '#tui/components/Terminal';
import type { DOMElement } from 'ink';
import type { Readable, Writable } from 'node:stream';

type AppProps = {
  onQuit: () => void;
  /** Keystrokes from the focused terminal. */
  stdin: Writable;
  /** Bytes painted in the terminal pane. */
  stdout: Readable;
};

const App = ({ onQuit, stdin, stdout }: AppProps) => {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const quitRef = useRef<DOMElement>(null);
  const quit = (): void => {
    onQuit();
    exit();
  };
  useClick(quitRef, quit);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Terminal stdin={stdin} stdout={stdout} />
      <Box width="100%" backgroundColor="blue">
        <Box ref={quitRef} paddingX={1}>
          <Text color="white" backgroundColor="blue">
            Quit
          </Text>
        </Box>
      </Box>
    </Box>
  );
};

export default App;
export type { AppProps };
