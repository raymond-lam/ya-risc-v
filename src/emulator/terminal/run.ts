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

import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { popTransmit, pushReceive } from '#emulator/memory';
import type { TerminalWorkerData } from '#emulator/terminal/types';

/** How often to poll the UART TX ring when it is empty. */
const TRANSMIT_POLL_MS = 1;

const writeByte = async (stdout: Writable, value: number): Promise<void> => {
  if (!stdout.write(Buffer.from([value]))) {
    await once(stdout, 'drain');
  }
};

const pumpTransmit = async (
  memory: TerminalWorkerData['memory'],
  stdout: Writable
): Promise<void> => {
  for (;;) {
    let value = popTransmit(memory);
    if (value === null) {
      await sleep(TRANSMIT_POLL_MS);
      continue;
    }
    while (value !== null) {
      await writeByte(stdout, value);
      value = popTransmit(memory);
    }
  }
};

const main = (): void => {
  const { memory, stdin: stdinWeb, stdout: stdoutWeb } = workerData as TerminalWorkerData;
  const stdin = Readable.fromWeb(stdinWeb);
  const stdout = Writable.fromWeb(stdoutWeb);

  const onStdinData = (chunk: Buffer): void => {
    for (const byte of chunk) {
      pushReceive(memory, byte);
    }
  };
  stdin.on('data', onStdinData);
  const stopStdin = (): void => {
    stdin.off('data', onStdinData);
  };
  stdin.once('close', stopStdin);
  parentPort?.once('close', stopStdin);

  void pumpTransmit(memory, stdout);
};

if (parentPort !== null) {
  main();
}
