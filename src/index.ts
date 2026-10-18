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
import { Command, InvalidArgumentError, Option } from 'commander';
import { create as createEmulator } from '#emulator';
import { CLINT_GUEST_BYTE_LENGTH, CLINT_REGION_ID } from '#emulator/clint';
import { PLIC_GUEST_BYTE_LENGTH, PLIC_REGION_ID } from '#emulator/plic';
import { RAM_REGION_ID } from '#emulator/ram';
import { SYSCON_GUEST_BYTE_LENGTH, SYSCON_REGION_ID } from '#emulator/syscon';
import { UART_GUEST_BYTE_LENGTH, UART_REGION_ID } from '#emulator/uart';
import type { DeviceTreeAddress } from '#fdt';
import { create as createTui } from '#tui';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes } from '#utils/bytes';

/** Guest window passed to the emulator (`guestAddress` / `guestByteLength`). */
type GuestWindow = {
  guestAddress: ReadonlyUint8Array;
  guestByteLength: bigint;
};

/** Virt-like guest map used when a base flag is omitted. */
const DEFAULT_RAM_BASE_ADDRESS = 0x8000_0000n;
const DEFAULT_UART_BASE_ADDRESS = 0x1000_0000n;
const DEFAULT_CLINT_BASE_ADDRESS = 0x0200_0000n;
const DEFAULT_PLIC_BASE_ADDRESS = 0x0c00_0000n;
const DEFAULT_SYSCON_BASE_ADDRESS = 0x0010_0000n;
const DEFAULT_TIMEBASE_HZ = 10_000_000n;
const TIMEBASE_HZ_MAX = 0xffff_ffffn;

const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

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

const parseGuestAddress =
  (label: string) =>
  (value: string): bigint => {
    try {
      const address = BigInt(value);
      if (address < 0n || address > UINT64_MAX) {
        throw new InvalidArgumentError(`${label} must be an integer from 0 through 2^64-1.`);
      }
      return address;
    } catch (error) {
      if (error instanceof InvalidArgumentError) {
        throw error;
      }
      throw new InvalidArgumentError(`${label} must be an integer (decimal or 0x… hex).`);
    }
  };

const parseTimebaseHz = (value: string): bigint => {
  try {
    const timebaseHz = BigInt(value);
    if (timebaseHz < 1n || timebaseHz > TIMEBASE_HZ_MAX) {
      throw new InvalidArgumentError(
        'timebase frequency must be an integer from 1 through 2^32-1.'
      );
    }
    return timebaseHz;
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw error;
    }
    throw new InvalidArgumentError('timebase frequency must be an integer (decimal or 0x… hex).');
  }
};

const guestAddressBytes = (address: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), address) as ReadonlyUint8Array;

const guestWindow = (address: bigint, guestByteLength: bigint): GuestWindow => ({
  guestAddress: guestAddressBytes(address),
  guestByteLength,
});

type CliOptions = {
  ramSize: bigint;
  ramBase: bigint;
  uartBase: bigint;
  clintBase: bigint;
  plicBase: bigint;
  sysconBase: bigint;
  timebaseFrequency: bigint;
  /** Set by `--no-device-tree`. Commander defaults this to true. */
  deviceTree: boolean;
  dtbAddress?: bigint;
  resetPc?: bigint;
};

const deviceTreeAddress = (options: CliOptions): DeviceTreeAddress => {
  if (!options.deviceTree) {
    if (options.dtbAddress !== undefined) {
      throw new InvalidArgumentError('--dtb-address cannot be used with --no-device-tree.');
    }
    return null;
  }
  if (options.dtbAddress !== undefined) {
    return guestAddressBytes(options.dtbAddress);
  }
  return 'end';
};

const guestRegions = (options: CliOptions): ReadonlyMap<string, GuestWindow> =>
  new Map([
    [RAM_REGION_ID, guestWindow(options.ramBase, options.ramSize)],
    [UART_REGION_ID, guestWindow(options.uartBase, UART_GUEST_BYTE_LENGTH)],
    [CLINT_REGION_ID, guestWindow(options.clintBase, CLINT_GUEST_BYTE_LENGTH)],
    [PLIC_REGION_ID, guestWindow(options.plicBase, PLIC_GUEST_BYTE_LENGTH)],
    [SYSCON_REGION_ID, guestWindow(options.sysconBase, SYSCON_GUEST_BYTE_LENGTH)],
  ]);

const guestBaseOption = (
  flags: string,
  description: string,
  label: string,
  address: bigint,
  shown: string
): Option =>
  new Option(flags, description).default(address, shown).argParser(parseGuestAddress(label));

const main = async (imagePath: string, options: CliOptions): Promise<void> => {
  const image = await readFile(imagePath);
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  const emulator = createEmulator({
    image,
    stdin,
    stdout,
    guestRegions: guestRegions(options),
    timebaseHz: options.timebaseFrequency,
    deviceTreeAddress: deviceTreeAddress(options),
    resetPc: guestAddressBytes(options.resetPc ?? options.ramBase),
  });
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
  .addOption(
    guestBaseOption(
      '--ram-base <address>',
      'guest DRAM base address (decimal or 0x… hex); reset PC matches',
      'ram base',
      DEFAULT_RAM_BASE_ADDRESS,
      '0x80000000'
    )
  )
  .addOption(
    new Option(
      '--reset-pc <address>',
      'guest address of the first fetch (decimal or 0x… hex). Defaults to the RAM base'
    ).argParser(parseGuestAddress('reset PC'))
  )
  .addOption(
    guestBaseOption(
      '--uart-base <address>',
      'guest UART MMIO base address (decimal or 0x… hex)',
      'uart base',
      DEFAULT_UART_BASE_ADDRESS,
      '0x10000000'
    )
  )
  .addOption(
    guestBaseOption(
      '--clint-base <address>',
      'guest CLINT MMIO base address (decimal or 0x… hex)',
      'clint base',
      DEFAULT_CLINT_BASE_ADDRESS,
      '0x02000000'
    )
  )
  .addOption(
    guestBaseOption(
      '--plic-base <address>',
      'guest PLIC MMIO base address (decimal or 0x… hex)',
      'plic base',
      DEFAULT_PLIC_BASE_ADDRESS,
      '0x0c000000'
    )
  )
  .addOption(
    guestBaseOption(
      '--syscon-base <address>',
      'guest syscon MMIO base address (decimal or 0x… hex)',
      'syscon base',
      DEFAULT_SYSCON_BASE_ADDRESS,
      '0x00100000'
    )
  )
  .addOption(
    new Option('--timebase-frequency <hz>', 'CLINT mtime frequency in hertz (decimal or 0x… hex)')
      .default(DEFAULT_TIMEBASE_HZ, '10000000')
      .argParser(parseTimebaseHz)
  )
  .addOption(
    new Option(
      '--dtb-address <address>',
      'guest physical address of the device tree (decimal or 0x… hex)'
    ).argParser(parseGuestAddress('dtb address'))
  )
  .option('--no-device-tree', 'do not store a device tree; a1 stays zero')
  .action(async (image: string, options: CliOptions) => {
    await main(image, options);
  });

if (import.meta.main) {
  program.parseAsync(process.argv).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
