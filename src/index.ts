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
import { Command, InvalidArgumentError } from 'commander';
import { create as createEmulator } from '#emulator';
import { create as createTui } from '#tui';

const parseRamSize = (value: string): bigint => {
  try {
    const ramSize = BigInt(value);
    if (ramSize < 0n) {
      throw new InvalidArgumentError('ram size must be non-negative.');
    }
    return ramSize;
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw error;
    }
    throw new InvalidArgumentError('ram size must be an integer (decimal or 0x… hex).');
  }
};

const main = async (imagePath: string, ramSize: bigint): Promise<void> => {
  const image = await readFile(imagePath);
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  const emulator = createEmulator({ image, stdin, stdout, ramSize });
  const tui = createTui({
    stdin,
    stdout,
    onShutdown: () => {
      try {
        emulator.stop();
      } catch {
        // Already stopped / never started / peer already torn down.
      }
    },
  });

  const shutdown = (): void => {
    try {
      emulator.stop();
    } catch {
      // Already stopped / never started / peer already torn down.
    }
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  tui.start();
  emulator.start();
  try {
    await emulator;
  } finally {
    try {
      tui.stop();
    } catch {
      // Already stopped / never started / peer already torn down.
    }
    try {
      await tui;
    } catch {
      // TUI lifetime may already have rejected or resolved via unmount.
    }
    stdin.destroy();
    stdout.destroy();
  }
};

const program = new Command();

program
  .name('ya-risc-v')
  .description('RISC-V emulator')
  .argument('<image>', 'path to a program image to load into guest memory')
  .requiredOption(
    '--ram-size <bytes>',
    'guest DRAM size in bytes (decimal or 0x… hex); must fit the image',
    parseRamSize
  )
  .action(async (image: string, options: { ramSize: bigint }) => {
    await main(image, options.ramSize);
  });

if (import.meta.main) {
  program.parseAsync(process.argv).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
