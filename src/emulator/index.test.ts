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

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { create } from '#emulator';
import { CLINT_GUEST_BYTE_LENGTH, CLINT_REGION_ID } from '#emulator/clint';
import { PLIC_GUEST_BYTE_LENGTH, PLIC_REGION_ID } from '#emulator/plic';
import { RAM_REGION_ID } from '#emulator/ram';
import { create as createTerminal } from '#emulator/terminal';
import { create as createTimer } from '#emulator/timer';
import { UART_GUEST_BYTE_LENGTH, UART_REGION_ID } from '#emulator/uart';
import createTestMemory from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes } from '#utils/bytes';

const guest = (address: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), address) as ReadonlyUint8Array;

const window = (
  address: bigint,
  guestByteLength: bigint
): { guestAddress: ReadonlyUint8Array; guestByteLength: bigint } => ({
  guestAddress: guest(address),
  guestByteLength,
});

/** Explicit virt-like windows passed into `create` (the emulator has no defaults). */
const virtRegions = (
  ramByteLength: bigint,
  ramBase: bigint = 0x8000_0000n
): Map<string, { guestAddress: ReadonlyUint8Array; guestByteLength: bigint }> =>
  new Map([
    [RAM_REGION_ID, window(ramBase, ramByteLength)],
    [UART_REGION_ID, window(0x1000_0000n, UART_GUEST_BYTE_LENGTH)],
    [CLINT_REGION_ID, window(0x0200_0000n, CLINT_GUEST_BYTE_LENGTH)],
    [PLIC_REGION_ID, window(0x0c00_0000n, PLIC_GUEST_BYTE_LENGTH)],
  ]);

/** Minimal thenable handle that can reject like a worker lifetime. */
const createFailingHandle = (
  message: string
): PromiseLike<void> & {
  start: () => void;
  stop: () => void;
} => {
  const lifetime = Promise.withResolvers<void>();
  let stopped = false;
  return {
    start: (): void => {
      queueMicrotask(() => {
        if (!stopped) {
          lifetime.reject(new Error(message));
        }
      });
    },
    stop: (): void => {
      stopped = true;
      lifetime.resolve();
    },
    then: lifetime.promise.then.bind(lifetime.promise),
  };
};

describe('emulator create', () => {
  it('rejects an image that does not fit in the ram region', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    assert.throws(
      () =>
        create({
          image: new Uint8Array(16),
          stdin,
          stdout,
          guestRegions: virtRegions(8n),
          timebaseHz: 10_000_000n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x8000_0000n),
        }),
      { name: 'RangeError', message: /does not fit in ram region/ }
    );
  });

  it('rejects a reset PC outside the ram region', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    assert.throws(
      () =>
        create({
          image: new Uint8Array(0),
          stdin,
          stdout,
          guestRegions: virtRegions(16n),
          timebaseHz: 10_000_000n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x1000n),
        }),
      { name: 'RangeError', message: /reset PC is outside the ram region/ }
    );
  });

  it('rejects a timebase frequency outside 1 through 2^32-1', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    assert.throws(
      () =>
        create({
          image: new Uint8Array(0),
          stdin,
          stdout,
          guestRegions: virtRegions(16n),
          timebaseHz: 0n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x8000_0000n),
        }),
      { name: 'RangeError', message: /timebase frequency/ }
    );
  });

  it('start then stop joins without leaving workers hanging', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    // Single `wfi` encoding; hart advances PC then waits until host stop terminates it.
    const image = new Uint8Array([0x73, 0x00, 0x50, 0x10]);
    const emulator = create({
      image,
      stdin,
      stdout,
      guestRegions: virtRegions(4096n, 0x9000_0000n),
      timebaseHz: 10_000_000n,
      deviceTreeAddress: 'end',
      resetPc: guest(0x9000_0000n),
    });
    emulator.start();
    emulator.stop();
    await emulator;
  });

  it('stop before start is idempotent and unblocks await', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const image = new Uint8Array([0x73, 0x00, 0x50, 0x10]);
    const emulator = create({
      image,
      stdin,
      stdout,
      guestRegions: virtRegions(4096n),
      timebaseHz: 10_000_000n,
      deviceTreeAddress: 'end',
      resetPc: guest(0x8000_0000n),
    });
    emulator.stop();
    emulator.stop();
    await emulator;
    assert.throws(
      () => {
        emulator.start();
      },
      { message: 'Already stopped.' }
    );
  });

  it('rejects guest windows that overlap', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const regions = virtRegions(16n);
    const uart = regions.get(UART_REGION_ID);
    assert.ok(uart !== undefined);
    regions.set(RAM_REGION_ID, {
      guestAddress: uart.guestAddress,
      guestByteLength: 16n,
    });
    assert.throws(
      () =>
        create({
          image: new Uint8Array(0),
          stdin,
          stdout,
          guestRegions: regions,
          timebaseHz: 10_000_000n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x8000_0000n),
        }),
      { name: 'RangeError', message: 'ram window overlaps uart.' }
    );
  });

  it('rejects a guest region map that omits a required id', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const regions = virtRegions(16n);
    regions.delete(CLINT_REGION_ID);
    assert.throws(
      () =>
        create({
          image: new Uint8Array(0),
          stdin,
          stdout,
          guestRegions: regions,
          timebaseHz: 10_000_000n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x8000_0000n),
        }),
      { name: 'RangeError', message: "Missing guest region 'clint'." }
    );
  });

  it('rejects an unknown guest region id', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const regions = virtRegions(16n);
    regions.set('disk', window(0x4000_0000n, 16n));
    assert.throws(
      () =>
        create({
          image: new Uint8Array(0),
          stdin,
          stdout,
          guestRegions: regions,
          timebaseHz: 10_000_000n,
          deviceTreeAddress: 'end',
          resetPc: guest(0x8000_0000n),
        }),
      { name: 'RangeError', message: "Unknown guest region 'disk'." }
    );
  });

  it('timer and terminal stop before start is idempotent', async () => {
    const memory = createTestMemory(256n);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const timer = createTimer({ memory });
    const terminal = createTerminal({ memory, stdin, stdout });
    timer.stop();
    terminal.stop();
    timer.stop();
    terminal.stop();
    await Promise.all([timer, terminal]);
  });

  it('stops live timer and terminal workers when a sibling rejects', async () => {
    const memory = createTestMemory(256n);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const timer = createTimer({ memory });
    const terminal = createTerminal({ memory, stdin, stdout });
    const failing = createFailingHandle('forced worker failure');

    timer.start();
    terminal.start();
    failing.start();

    await assert.rejects(
      async () => {
        try {
          await Promise.all([failing, timer, terminal]);
        } finally {
          failing.stop();
          timer.stop();
          terminal.stop();
        }
      },
      { message: 'forced worker failure' }
    );

    // Siblings must have been stopped; otherwise these awaits hang.
    await Promise.all([timer, terminal]);
  });
});
