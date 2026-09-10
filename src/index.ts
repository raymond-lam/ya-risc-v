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
import { Command, InvalidArgumentError } from 'commander';
import { createMemory } from '#memory.js';
import { run } from '#cpu/index.js';
import { unsignedBigIntToBytes } from '#utils/bytes.js';
import type { Memory, ReadonlyUint8Array } from '#types.js';

const parseGuestAddress = (value: string): ReadonlyUint8Array => {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new InvalidArgumentError(`invalid guest address: ${value}`);
  }
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) {
    throw new InvalidArgumentError(`guest address out of u64 range: ${value}`);
  }
  return unsignedBigIntToBytes(new Uint8Array(8), parsed) as ReadonlyUint8Array;
};

type RunGuestOptions = {
  ramBase: ReadonlyUint8Array;
  uartBase: ReadonlyUint8Array;
  resetPc: ReadonlyUint8Array | undefined;
};

const runGuest = async (imagePath: string, options: RunGuestOptions): Promise<void> => {
  const image = await readFile(imagePath);
  const ramSize = BigInt(image.byteLength);
  const { ramBase, uartBase } = options;
  const resetPc = options.resetPc ?? ramBase;
  const memory: Memory = {
    bytes: createMemory({
      ramBaseAddress: ramBase,
      ramSize,
      uartBaseAddress: uartBase,
    }),
    ramBaseAddress: ramBase,
    ramSize,
    uartBaseAddress: uartBase,
  };
  memory.bytes.set(image);

  const cpu = run({
    memory,
    resetPc,
  });

  const shutdown = (): void => {
    cpu.terminate();
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await cpu;
};

const program = new Command();

program
  .name('ya-risc-v')
  .description('RISC-V emulator')
  .argument('<image>', 'path to a program image to load into guest memory')
  .option(
    '--ram-base <address>',
    'guest physical address of the start of RAM (image load address)',
    parseGuestAddress,
    parseGuestAddress('0')
  )
  .option(
    '--uart-base <address>',
    'guest physical address of the UART MMIO window',
    parseGuestAddress,
    parseGuestAddress('0x10000000')
  )
  .option(
    '--reset-pc <address>',
    'reset program counter (defaults to --ram-base)',
    parseGuestAddress
  )
  .action(async (image: string, options: RunGuestOptions) => {
    await runGuest(image, options);
  });

if (import.meta.main) {
  void program.parseAsync(process.argv);
}
