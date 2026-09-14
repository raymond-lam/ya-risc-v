#!/usr/bin/env node

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

import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';
import { create as createEmulator } from '#emulator';
import { create as createTui } from '#tui';

const main = async (imagePath: string): Promise<void> => {
  const image = await readFile(imagePath);
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  const emulator = createEmulator({ image, stdin, stdout });
  const tui = createTui({
    stdin,
    stdout,
    onShutdown: () => {
      emulator.stop();
    },
  });

  const shutdown = (): void => {
    emulator.stop();
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  tui.start();
  emulator.start();
  await emulator;
  tui.stop();
  await tui;
};

const program = new Command();

program
  .name('ya-risc-v')
  .description('RISC-V emulator')
  .argument('<image>', 'path to a program image to load into guest memory')
  .action(async (image: string) => {
    await main(image);
  });

if (import.meta.main) {
  void program.parseAsync(process.argv);
}
