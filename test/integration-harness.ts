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

/**
 * Whole-machine integration harness: boots the real `Emulator` (hart + timer +
 * terminal workers over one `SharedArrayBuffer`) against the standard virtual
 * map and lets the guest terminate itself through syscon poweroff.
 *
 * Image discipline for guests run through this harness (maintainer-mandated,
 * non-negotiable):
 *   - One instruction per line: 4 bytes little-endian, or 2 bytes for RVC.
 *   - Every line carries a `// mnemonic operands — intent` comment.
 *   - No 64-bit padding lanes. A 4-byte instruction occupies exactly one line and
 *     the PC advances 4 bytes; a 2-byte instruction advances 2. Padding an
 *     instruction out to 8 bytes makes the run loop fetch the padding instead,
 *     decode 0x00000000 → illegal instruction → mtvec(0) → PC(0) trap loop.
 *   - Data rows would be 8-byte-aligned with alignment padding only at the
 *     instruction→data boundary; none of the current images need a data section.
 *   - `prettier-ignore` keeps the hand-laid-out bytes intact under `npm run fix`.
 *   - Yank-safety: the syscon power cut is a nondeterministic host teardown of the
 *     worker (no in-worker halt check), so after the finisher store every guest
 *     spins in `jal x0, 0` (0x0000006f — never 0x00000000, that is an illegal
 *     instruction) and does nothing observable until the worker dies.
 *
 * Encoding notes that matter for hand-checking the bytes:
 *   - `lui` shifts its 20-bit field into bits 31:12 and sign-extends bit 31, so a
 *     `lui` cannot materialise the 0x8000_0000 RAM base; PC-relative addresses
 *     (`auipc` + `addi`) are used instead of a `lui`-built one.
 *   - B-type branches carry imm[12]|imm[10:5]|imm[4:1]|imm[11] split across four
 *     fields; every backwards branch in current images re-lands on the
 *     instruction that runs the poll.
 *   - CSR numbers: mstatus 0x300, mie 0x304, mtvec 0x305, mcause 0x342. `csrrsi`
 *     has only a 5-bit zimm, so mie.MTIE (bit 7) is written through a register
 *     instead.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { create, type EmulatorHandle } from '#emulator';
import { CLINT_GUEST_BYTE_LENGTH, CLINT_REGION_ID } from '#emulator/clint';
import { PLIC_GUEST_BYTE_LENGTH, PLIC_REGION_ID } from '#emulator/plic';
import { RAM_REGION_ID } from '#emulator/ram';
import { SYSCON_GUEST_BYTE_LENGTH, SYSCON_REGION_ID } from '#emulator/syscon';
import { UART_GUEST_BYTE_LENGTH, UART_REGION_ID } from '#emulator/uart';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes } from '#utils/bytes';

export const RAM_BASE = 0x8000_0000n;
const RAM_BYTE_LENGTH = 0x100_000n;
/** 10 MHz: one `mtime` tick is 100 ns. */
export const TIMEBASE_HZ = 10_000_000n;

/** Ceiling for one emulator interaction; node:test's per-test timeout is the outer backstop. */
const DEADLINE_MS = 10_000;
const OUTPUT_POLL_INTERVAL_MS = 2;

const guestAddress = (address: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), address);

/** Standard virtual map: ram → uart → clint → plic → syscon (the emulator packs the rest). */
const guestRegions = (): Map<
  string,
  { guestAddress: ReadonlyUint8Array; guestByteLength: bigint }
> =>
  new Map([
    [RAM_REGION_ID, { guestAddress: guestAddress(RAM_BASE), guestByteLength: RAM_BYTE_LENGTH }],
    [
      UART_REGION_ID,
      { guestAddress: guestAddress(0x1000_0000n), guestByteLength: UART_GUEST_BYTE_LENGTH },
    ],
    [
      CLINT_REGION_ID,
      { guestAddress: guestAddress(0x0200_0000n), guestByteLength: CLINT_GUEST_BYTE_LENGTH },
    ],
    [
      PLIC_REGION_ID,
      { guestAddress: guestAddress(0x0c00_0000n), guestByteLength: PLIC_GUEST_BYTE_LENGTH },
    ],
    [
      SYSCON_REGION_ID,
      { guestAddress: guestAddress(0x0010_0000n), guestByteLength: SYSCON_GUEST_BYTE_LENGTH },
    ],
  ]);

/** Bytes the guest has pushed out of the UART, as the host stream delivers them. */
export type GuestOutput = {
  text: () => string;
  /** Bounded poll: resolve once at least `byteCount` bytes reached the host stream. */
  waitForByteCount: (byteCount: number) => Promise<void>;
};

const collectOutput = (stdout: PassThrough): GuestOutput => {
  let text = '';
  stdout.on('data', (chunk: Buffer) => {
    text += chunk.toString('latin1');
  });
  return {
    text: () => text,
    waitForByteCount: async (byteCount: number): Promise<void> => {
      const deadline = Date.now() + DEADLINE_MS;
      while (text.length < byteCount) {
        if (Date.now() > deadline) {
          throw new Error(
            `UART sent ${JSON.stringify(text)} in ${DEADLINE_MS}ms, want ${byteCount} bytes`
          );
        }
        await delay(OUTPUT_POLL_INTERVAL_MS);
      }
    },
  };
};

/** Resolve when the emulator lifetime settles; reject on its error or on the deadline. */
const settleEmulator = async (emulator: EmulatorHandle): Promise<void> => {
  const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    rejectDeadline(new Error(`emulator did not settle within ${DEADLINE_MS}ms`));
  }, DEADLINE_MS);
  try {
    await Promise.race([emulator.then(() => undefined), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Assert the guest printed exactly `expected` and then powered off: the print is
 * drained guest-side (LSR.TEMT poll) before the syscon store, so the host only has
 * to wait for the terminal worker's last hand-off, and the emulator lifetime
 * settling proves the poweroff reached the host.
 */
const expectPrintThenPoweroff = async (
  output: GuestOutput,
  emulator: EmulatorHandle,
  expected: string
): Promise<void> => {
  await output.waitForByteCount(expected.length);
  assert.equal(output.text(), expected);
  await settleEmulator(emulator);
  assert.equal(output.text(), expected, 'no UART bytes after syscon poweroff');
};

/** Boot the real machine around `image`, run `body`, and always tear it down. */
const runGuest = async (
  image: Uint8Array,
  body: (context: {
    stdin: PassThrough;
    output: GuestOutput;
    emulator: EmulatorHandle;
  }) => Promise<void>
): Promise<void> => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const output = collectOutput(stdout);
  const emulator = create({
    image,
    stdin,
    stdout,
    guestRegions: guestRegions(),
    resetPc: guestAddress(RAM_BASE),
    timebaseHz: TIMEBASE_HZ,
    deviceTreeAddress: 'end',
  });
  try {
    emulator.start();
    await body({ stdin, output, emulator });
  } finally {
    emulator.stop();
    await settleEmulator(emulator);
  }
};

export {
  collectOutput,
  expectPrintThenPoweroff,
  guestAddress,
  guestRegions,
  runGuest,
  settleEmulator,
};
