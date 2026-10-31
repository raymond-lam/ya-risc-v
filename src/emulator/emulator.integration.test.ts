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
 * Whole-machine integration tests: each test boots the real `Emulator` (hart +
 * timer + terminal workers over one `SharedArrayBuffer`) against the standard
 * virtual map and lets the guest terminate itself through syscon poweroff.
 *
 * Image discipline (maintainer-mandated, non-negotiable):
 *   - One instruction per line: 4 bytes little-endian, or 2 bytes for RVC.
 *   - Every line carries a `// mnemonic operands — intent` comment.
 *   - No 64-bit padding lanes. A 4-byte instruction occupies exactly one line and
 *     the PC advances 4 bytes; a 2-byte instruction advances 2. Padding an
 *     instruction out to 8 bytes makes the run loop fetch the padding instead,
 *     decode 0x00000000 → illegal instruction → mtvec(0) → PC(0) trap loop.
 *   - Data rows would be 8-byte-aligned with alignment padding only at the
 *     instruction→data boundary; none of the images below need a data section.
 *   - `prettier-ignore` keeps the hand-laid-out bytes intact under `npm run fix`.
 *   - Yank-safety: the syscon power cut is a nondeterministic host teardown of the
 *     worker (no in-worker halt check), so after the finisher store every guest
 *     spins in `jal x0, 0` (0x0000006f — never 0x00000000, that is an illegal
 *     instruction) and does nothing observable until the worker dies.
 *
 * Every instruction below is 4-byte aligned so the common straight-line fetch
 * path is what is under test; the RVC image deliberately mixes 2-byte
 * instructions with a 4-byte `lui` at a 4-byte boundary.
 *
 * Encoding notes that matter for hand-checking the bytes:
 *   - `lui` shifts its 20-bit field into bits 31:12 and sign-extends bit 31, so a
 *     `lui` cannot materialise the 0x8000_0000 RAM base; PC-relative addresses
 *     (`auipc` + `addi`) are used instead of a `lui`-built one.
 *   - B-type branches carry imm[12]|imm[10:5]|imm[4:1]|imm[11] split across four
 *     fields; every backwards branch below re-lands on the instruction that runs
 *     the poll.
 *   - CSR numbers: mstatus 0x300, mie 0x304, mtvec 0x305, mcause 0x342. `csrrsi`
 *     has only a 5-bit zimm, so mie.MTIE (bit 7) is written through a register instead.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { create, type EmulatorHandle } from '#emulator';
import { CLINT_GUEST_BYTE_LENGTH, CLINT_REGION_ID } from '#emulator/clint';
import { PLIC_GUEST_BYTE_LENGTH, PLIC_REGION_ID } from '#emulator/plic';
import { RAM_REGION_ID } from '#emulator/ram';
import { SYSCON_GUEST_BYTE_LENGTH, SYSCON_REGION_ID } from '#emulator/syscon';
import { UART_GUEST_BYTE_LENGTH, UART_REGION_ID } from '#emulator/uart';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes } from '#utils/bytes';

const RAM_BASE = 0x8000_0000n;
const RAM_BYTE_LENGTH = 0x100_000n;
/** 10 MHz: one `mtime` tick is 100 ns. */
const TIMEBASE_HZ = 10_000_000n;

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
type GuestOutput = {
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

describe('emulator integration (real machine, no mocks)', () => {
  it(
    'computes values, prints them through the UART, and powers off',
    { timeout: 20_000 },
    async () => {
      // x7 = 40 + 2 + 1 = 43 = '+', then '!' through a word store: a 4-byte store
      // to THR pushes its low byte and lands the upper bytes in IER/IIR/LCR (all
      // zero here, the reset values). Then LSR.TEMT gates the poweroff.
      // prettier-ignore
      const image = new Uint8Array([
        0x37, 0x05, 0x00, 0x10, // lui  x10, 0x10000 — UART base 0x1000_0000
        0x93, 0x02, 0x80, 0x02, // addi x5, x0, 40 — 40
        0x13, 0x03, 0x20, 0x00, // addi x6, x0, 2 — 2
        0xb3, 0x83, 0x62, 0x00, // add  x7, x5, x6 — 42
        0x93, 0x83, 0x13, 0x00, // addi x7, x7, 1 — 43 = '+'
        0x23, 0x00, 0x75, 0x00, // sb   x7, 0(x10) — print '+'
        0x13, 0x04, 0x10, 0x02, // addi x8, x0, 33 — 33 = '!'
        0x23, 0x20, 0x85, 0x00, // sw   x8, 0(x10) — print '!' (word store to THR)
        0x83, 0x05, 0x55, 0x00, // drain: lb x11, 5(x10) — LSR
        0x93, 0xf5, 0x05, 0x04, // andi x11, x11, 64 — LSR.TEMT
        0xe3, 0x8c, 0x05, 0xfe, // beq  x11, x0, -8 — spin until the TX queue is drained
        0x37, 0x06, 0x10, 0x00, // lui  x12, 0x100 — syscon base 0x0010_0000
        0x93, 0x06, 0x10, 0x00, // addi x13, x0, 1 — syscon poweroff value
        0x23, 0x20, 0xd6, 0x00, // sw   x13, 0(x12) — syscon poweroff (the finisher store)
        0x6f, 0x00, 0x00, 0x00, // jal  x0, 0 — yank-safe spin: the power cut is nondeterministic
      ]);

      await runGuest(image, ({ output, emulator }) =>
        expectPrintThenPoweroff(output, emulator, '+!')
      );
    }
  );

  it('echoes host stdin bytes back through the UART to stdout', { timeout: 20_000 }, async () => {
    // Poll LSR.DR, pop RBR, push THR — eight times — then LSR.TEMT + poweroff.
    // prettier-ignore
    const image = new Uint8Array([
        0x37, 0x05, 0x00, 0x10, // lui  x10, 0x10000 — UART base 0x1000_0000
        0x93, 0x05, 0x80, 0x00, // addi x11, x0, 8 — bytes left to echo
        0x03, 0x06, 0x55, 0x00, // loop: lb x12, 5(x10) — LSR
        0x13, 0x76, 0x16, 0x00, // andi x12, x12, 1 — LSR.DR
        0xe3, 0x0c, 0x06, 0xfe, // beq  x12, x0, -8 — spin until a byte arrives
        0x83, 0x06, 0x05, 0x00, // lb   x13, 0(x10) — pop RBR
        0x23, 0x00, 0xd5, 0x00, // sb   x13, 0(x10) — echo to THR
        0x93, 0x85, 0xf5, 0xff, // addi x11, x11, -1 — one byte fewer to echo
        0xe3, 0x94, 0x05, 0xfe, // bne  x11, x0, -24 — back to loop
        0x03, 0x07, 0x55, 0x00, // drain: lb x14, 5(x10) — LSR
        0x13, 0x77, 0x07, 0x04, // andi x14, x14, 64 — LSR.TEMT
        0xe3, 0x0c, 0x07, 0xfe, // beq  x14, x0, -8 — spin until the TX queue is drained
        0xb7, 0x07, 0x10, 0x00, // lui  x15, 0x100 — syscon base 0x0010_0000
        0x13, 0x08, 0x10, 0x00, // addi x16, x0, 1 — syscon poweroff value
        0x23, 0xa0, 0x07, 0x01, // sw   x16, 0(x15) — syscon poweroff (the finisher store)
        0x6f, 0x00, 0x00, 0x00, // jal  x0, 0 — yank-safe spin: the power cut is nondeterministic
      ]);

    const input = 'echo-42!';
    await runGuest(image, async ({ stdin, output, emulator }) => {
      stdin.write(input);
      await expectPrintThenPoweroff(output, emulator, input);
    });
  });

  it(
    'a machine timer interrupt wakes wfi and runs the mtvec handler',
    { timeout: 20_000 },
    async () => {
      // mtimecmp = mtime + 2000 ticks (200 µs). mtvec is built PC-relatively with
      // auipc (0x18) + 28 = 0x34, the handler. On the trap mstatus.MIE clears and
      // mepc = wfi PC + 4 = 0x34, so the handler runs at the address wfi falls
      // through to. The handler first proves the trap really is a machine timer
      // interrupt: mcause must read exactly 0x8000_0000_0000_0007 (interrupt bit
      // 63 set, cause 7). `slli 1` drops the interrupt bit so 7 << 1 = 14 can be
      // compared exactly, and `srli 63` must leave 1. Any mismatch branches
      // forward to the `fail` self-loop at the end of the image, so the test
      // fails on the missing 'T' instead of printing one by luck. On a match it
      // prints 'T', drains, powers off, and spins (`jal x0, 0`): the syscon power
      // cut is a nondeterministic yank, so the happy path must run nothing
      // observable after the finisher store. The spin trails the poweroff store
      // so the happy path never falls into the fail loop.
      // prettier-ignore
      const image = new Uint8Array([
        0x37, 0xc5, 0x00, 0x02, // lui   x10, 0x200c — 0x0200_c000 (mtime is -8 from here)
        0x83, 0x35, 0x85, 0xff, // ld    x11, -8(x10) — live mtime at 0x0200_bff8
        0x13, 0x06, 0x00, 0x7d, // addi  x12, x0, 2000 — 2000 ticks = 200 µs at 10 MHz
        0xb3, 0x85, 0xc5, 0x00, // add   x11, x11, x12 — mtimecmp deadline
        0xb7, 0x46, 0x00, 0x02, // lui   x13, 0x2004 — 0x0200_4000 (mtimecmp)
        0x23, 0xb0, 0xb6, 0x00, // sd    x11, 0(x13) — arm the machine timer
        0x17, 0x07, 0x00, 0x00, // auipc x14, 0 — PC-relative handler base (0x8000_0018)
        0x13, 0x07, 0xc7, 0x01, // addi  x14, x14, 28 — handler at 0x8000_0034
        0x73, 0x10, 0x57, 0x30, // csrrw x0, mtvec(0x305), x14 — Direct-mode trap vector
        0x93, 0x07, 0x00, 0x08, // addi  x15, x0, 128 — mie.MTIE (bit 7; csrrsi zimm is 5 bits)
        0x73, 0x90, 0x47, 0x30, // csrrw x0, mie(0x304), x15 — enable machine timer interrupts
        0x73, 0x60, 0x04, 0x30, // csrrsi x0, mstatus(0x300), 8 — mstatus.MIE
        0x73, 0x00, 0x50, 0x10, // wfi — park until MTIP
        0xf3, 0x24, 0x20, 0x34, // handler: csrrs x9, mcause(0x342), x0 — read the trap cause
        0x93, 0x9c, 0x14, 0x00, // slli  x25, x9, 1 — drop the interrupt bit: 7 << 1 = 14
        0x13, 0x0d, 0xe0, 0x00, // addi  x26, x0, 14 — expected cause bits
        0x63, 0x9c, 0xac, 0x03, // bne   x25, x26, +56 — wrong cause bits: park in fail
        0x93, 0xdc, 0xf4, 0x03, // srli  x25, x9, 63 — 1 iff the interrupt bit is set
        0x13, 0x0d, 0x10, 0x00, // addi  x26, x0, 1 — expected interrupt bit
        0x63, 0x96, 0xac, 0x03, // bne   x25, x26, +44 — wrong interrupt level: park in fail
        0x37, 0x0a, 0x00, 0x10, // lui   x20, 0x10000 — UART base 0x1000_0000
        0x93, 0x0a, 0x40, 0x05, // addi x21, x0, 84 — 84 = 'T'
        0x23, 0x00, 0x5a, 0x01, // sb   x21, 0(x20) — print 'T'
        0x03, 0x0b, 0x5a, 0x00, // lb   x22, 5(x20) — LSR
        0x13, 0x7b, 0x0b, 0x04, // andi x22, x22, 64 — LSR.TEMT
        0xe3, 0x0c, 0x0b, 0xfe, // beq  x22, x0, -8 — spin until the TX queue is drained
        0xb7, 0x0b, 0x10, 0x00, // lui  x23, 0x100 — syscon base 0x0010_0000
        0x13, 0x0c, 0x10, 0x00, // addi x24, x0, 1 — syscon poweroff value
        0x23, 0xa0, 0x8b, 0x01, // sw   x24, 0(x23) — syscon poweroff (the finisher store)
        0x6f, 0x00, 0x00, 0x00, // jal  x0, 0 — yank-safe spin: the power cut is nondeterministic
        0x63, 0x00, 0x00, 0x00, // fail: beq x0, x0, 0 — wrong cause: spin here, never print 'T'
      ]);

      await runGuest(image, ({ output, emulator }) =>
        expectPrintThenPoweroff(output, emulator, 'T')
      );
    }
  );

  it(
    'fetches compressed instructions and advances the PC by two bytes',
    { timeout: 20_000 },
    async () => {
      // 65/66/67 = 'A'/'B'/'C' through c.sw; the drain is compressed too: c.lw on
      // UART+4 puts LSR in byte 1 of the loaded word (register window 4..7), so
      // c.srli 14 lifts TEMT into bit 0. Every RVC line advances the PC by 2.
      // prettier-ignore
      const image = new Uint8Array([
        0x37, 0x05, 0x00, 0x10, // lui    x10, 0x10000 — UART base 0x1000_0000
        0xaa, 0x85, // c.mv   x11, x10 — x11 = UART base (c.sw needs an x8–x15 base)
        0x91, 0x44, // c.li   x9, 4 — 4
        0x92, 0x04, // c.slli x9, 4 — 64
        0x85, 0x04, // c.addi x9, 1 — 65 = 'A'
        0x84, 0xc1, // c.sw   x9, 0(x11) — print 'A'
        0x85, 0x04, // c.addi x9, 1 — 66 = 'B'
        0x84, 0xc1, // c.sw   x9, 0(x11) — print 'B'
        0x85, 0x04, // c.addi x9, 1 — 67 = 'C'
        0x84, 0xc1, // c.sw   x9, 0(x11) — print 'C'
        0x91, 0x05, // c.addi x11, 4 — x11 = UART + 4 (register window 4..7, LSR is byte 1)
        0x90, 0x41, // loop: c.lw x12, 0(x11) — load MCR/LSR/MSR/SCR
        0x39, 0x82, // c.srli x12, 14 — LSR.TEMT (word bit 14) to bit 0
        0x75, 0xde, // c.beqz x12, -4 — spin until the TX queue is drained
        0x85, 0x44, // c.li   x9, 1 — syscon poweroff value
        0x37, 0x05, 0x10, 0x00, // lui  x10, 0x100 — syscon base 0x0010_0000
        0xaa, 0x85, // c.mv   x11, x10 — x11 = syscon base
        0x84, 0xc1, // c.sw   x9, 0(x11) — syscon poweroff (the finisher store)
        0x6f, 0x00, 0x00, 0x00, // jal  x0, 0 — yank-safe spin: the power cut is nondeterministic
      ]);

      await runGuest(image, ({ output, emulator }) =>
        expectPrintThenPoweroff(output, emulator, 'ABC')
      );
    }
  );
});
