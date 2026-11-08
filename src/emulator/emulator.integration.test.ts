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
 * Real-Emulator integration tests live together here: UART worker teardown, whole-machine
 * CPU/device behavior, and virtio disk I/O each exercise a boundary across the composed
 * machine. Leaf device mechanics remain covered by colocated package tests such as
 * `virtio/queue.test.ts`. The virtio guest images and their decode probe stay adjacent.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { create } from '#emulator';
import decode from '#emulator/cpu/decode';
import { FOUR_BYTES } from '#emulator/cpu/registers';
import {
  expectPrintThenPoweroff,
  guestAddress,
  guestRegions,
  RAM_BASE,
  runGuest,
  settleEmulator,
  TIMEBASE_HZ,
  type GuestOutput,
} from '#test/integration-harness';
import { bytesToBigInt, bytesToNumber } from '#utils/bytes';

type EmulatorHandle = ReturnType<typeof create>;

describe('emulator integration (TX-ring drain, real machine, no mocks)', () => {
  /**
   * Send 16 bytes, polling THRE before each write so a full TX ring drops none.
   * Poweroff can occur while accepted bytes are still queued; the drain must
   * deliver the entire burst. This does not guarantee a full ring at shutdown.
   */
  const burstImage = (poweroff: boolean): Uint8Array => {
    // prettier-ignore
    const tail = poweroff
      ? [
          0x37, 0x06, 0x10, 0x00, // lui  x12, 0x100 — syscon base 0x0010_0000
          0x93, 0x06, 0x10, 0x00, // addi x13, x0, 1 — syscon poweroff value
          0x23, 0x20, 0xd6, 0x00, // sw   x13, 0(x12) — syscon poweroff (the finisher store)
        ]
      : [];
    // prettier-ignore
    return new Uint8Array([
      0x37, 0x05, 0x00, 0x10, // lui  x10, 0x10000 — UART base 0x1000_0000
      0x93, 0x04, 0x10, 0x04, // addi x9, x0, 65 — 65 = 'A'
      0x93, 0x05, 0x00, 0x01, // addi x11, x0, 16 — send 16 bytes
      0x03, 0x47, 0x55, 0x00, // loop: lbu x14, 5(x10) — read LSR
      0x13, 0x77, 0x07, 0x02, // andi x14, x14, 0x20 — THRE
      0xe3, 0x0c, 0x07, 0xfe, // beq x14, x0, -8 — wait for space
      0x23, 0x00, 0x95, 0x00, // sb x9, 0(x10) — push one 'A'
      0x93, 0x85, 0xf5, 0xff, // addi x11, x11, -1 — one byte fewer
      0xe3, 0x96, 0x05, 0xfe, // bne x11, x0, -20 — back to loop
      ...tail,
      0x6f, 0x00, 0x00, 0x00, // jal  x0, 0 — yank-safe spin: the power cut is nondeterministic
    ]);
  };

  const BURST = 'A'.repeat(16);

  /** Run the burst image, run `body`, then assert the burst arrived. */
  const expectFullBurst = async (
    image: Uint8Array,
    body: (context: { output: GuestOutput; emulator: EmulatorHandle }) => Promise<void>
  ): Promise<void> => {
    await runGuest(image, async ({ output, emulator }) => {
      await body({ output, emulator });
      // The emulator lifetime settles once the terminal worker has flushed its
      // writable side, but the harness's PassThrough delivers the flushed bytes
      // to its 'data' listener on a later tick. Wait for every byte to reach the
      // host stream before asserting the exact burst, so the test never reads a
      // half-delivered ring. If the terminal drops a byte this wait times out
      // instead of passing.
      await output.waitForByteCount(BURST.length);
      assert.equal(output.text(), BURST);
    });
  };

  it('drains queued TX bytes when the guest powers off', { timeout: 20_000 }, async () => {
    await expectFullBurst(burstImage(true), ({ emulator }) => settleEmulator(emulator));
  });

  it('stops after the guest sends a TX burst', { timeout: 20_000 }, async () => {
    await expectFullBurst(burstImage(false), async ({ output, emulator }) => {
      // Gate host shutdown on observable guest progress, without exposing device internals.
      await output.waitForByteCount(BURST.length);
      await emulator.stop();
      await settleEmulator(emulator);
    });
  });
});

describe('emulator machine behavior (real machine, no mocks)', () => {
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

  it(
    'boots and powers off with no disk image bound (diskImagePath: null)',
    { timeout: 20_000 },
    async () => {
      // The explicit null pins the diskless worker path end to end. No disk
      // worker is spawned; the virtio window is still packed and the absent
      // device reads 0 for every register. Instruction words are the proven
      // syscon finisher tail from the TX-ring suite.
      // prettier-ignore
      const image = new Uint8Array([
        0x37, 0x06, 0x10, 0x00, // lui  x12, 0x100 — syscon base 0x0010_0000
        0x93, 0x06, 0x10, 0x00, // addi x13, x0, 1 — syscon poweroff value
        0x23, 0x20, 0xd6, 0x00, // sw   x13, 0(x12) — syscon poweroff (the finisher store)
        0x6f, 0x00, 0x00, 0x00, // jal  x0, 0 — yank-safe spin: the power cut is nondeterministic
      ]);

      await runGuest(image, ({ emulator }) => settleEmulator(emulator), {
        diskImagePath: null,
      });
    }
  );

  it(
    'rejects a missing disk image path through the disk worker error path',
    { timeout: 20_000 },
    async () => {
      // The virtio disk worker opens the image before servicing any request;
      // the open failure crashes the worker, the VirtioDisk host lifetime
      // rejects after the worker exits, and the emulator lifetime rejects
      // with the same cause. Bounded by the test timeout — never a wall-clock
      // sleep. The emulator's own lifetime finally stops the other workers, so
      // the trailing stop() is a no-op backstop.
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const emulator = create({
        image: new Uint8Array([0x73, 0x00, 0x50, 0x10]), // wfi — never reached
        stdin,
        stdout,
        guestRegions: guestRegions(),
        resetPc: guestAddress(RAM_BASE),
        timebaseHz: TIMEBASE_HZ,
        deviceTreeAddress: 'end',
        diskImagePath: join(tmpdir(), 'ya-risc-v-missing-disk', 'no-such-image.img'),
      });
      try {
        const startup = emulator.start();
        const shutdown = emulator.stop();
        assert.equal(emulator.stop(), shutdown);
        const error = await startup.then(
          () => assert.fail('missing image startup succeeded'),
          (reason: unknown) => reason
        );
        assert.match(String(error), /ENOENT|no such file or directory/);
        await assert.rejects(emulator, (reason: unknown) => reason === error);
        await assert.rejects(shutdown, (reason: unknown) => reason === error);
      } finally {
        await emulator.stop().catch(() => {});
      }
    }
  );
});

const DISK_BYTE_LENGTH = 1024;
const DISK_MAGIC = new Uint8Array([
  0x79,
  0x61,
  0x2d,
  0x72,
  0x69,
  0x73,
  0x63,
  0x2d,
  0x76,
  0x20,
  0x64,
  0x69,
  0x73,
  0x6b,
  0x21,
  0x21, // "ya-risc-v disk!!"
]);
/** disk[0..7] little-endian — must equal the guest image's EXP_HEAD row. */
const DISK_HEAD = 0x2d63_7369_722d_6179n;
/** disk[1016..1023] little-endian — must equal the guest image's EXP_TAIL row. */
const DISK_TAIL = 0x5a5b_5859_5e5f_5c5dn;

const buildDiskBytes = (): Uint8Array => {
  const bytes = new Uint8Array(DISK_BYTE_LENGTH);
  bytes.set(DISK_MAGIC, 0);
  for (let offset = DISK_MAGIC.length; offset < DISK_BYTE_LENGTH; offset += 1) {
    bytes[offset] = offset ^ 0xa5;
  }
  // Guard the cross-artifact contract: the guest literals pin these exact words,
  // so a mismatch here means image and disk drifted — fail at authoring time.
  assert.equal(bytesToBigInt(bytes.subarray(0, 8)), DISK_HEAD);
  assert.equal(bytesToBigInt(bytes.subarray(1016, 1024)), DISK_TAIL);
  return bytes;
};

const createTempDisk = (): { diskPath: string; remove: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'ya-risc-v-virtio-'));
  const diskPath = join(dir, 'disk.img');
  writeFileSync(diskPath, buildDiskBytes());
  return {
    diskPath,
    remove: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

// prettier-ignore
const pollImage = new Uint8Array([
      0x97, 0x02, 0x00, 0x00, // auipc x5, 0 — x5 = RAM base 0x8000_0000 (PC-relative)
      0x37, 0x1a, 0x00, 0x10, // lui  x20, 0x10001 — x20 = virtio base 0x1000_1000
      0x37, 0x05, 0x00, 0x10, // lui  x10, 0x10000 — x10 = UART base 0x1000_0000
      0x37, 0x06, 0x10, 0x00, // lui  x12, 0x100 — x12 = syscon base 0x0010_0000
      0x83, 0x23, 0x0a, 0x00, // lw   x7, 0(x20) — probe MagicValue (want 0x74726976)
      0x03, 0xa4, 0x02, 0x16, // lw   x8, 0x160(x5) — expected magic from the data section
      0x63, 0x94, 0x83, 0x10, // bne  x7, x8, fail — wrong magic: park in fail
      0x83, 0x23, 0x4a, 0x00, // lw   x7, 0x4(x20) — probe Version (want 2)
      0x03, 0xa4, 0x82, 0x16, // lw   x8, 0x168(x5) — expected version
      0x63, 0x9e, 0x83, 0x0e, // bne  x7, x8, fail — wrong version: park in fail
      0x83, 0x23, 0x8a, 0x00, // lw   x7, 0x8(x20) — probe DeviceID (want 2, block device)
      0x03, 0xa4, 0x02, 0x17, // lw   x8, 0x170(x5) — expected device id
      0x63, 0x98, 0x83, 0x0e, // bne  x7, x8, fail — wrong device id: park in fail
      0x83, 0x23, 0xca, 0x00, // lw   x7, 0xc(x20) — probe VendorID (want 0x554d4551)
      0x03, 0xa4, 0x82, 0x17, // lw   x8, 0x178(x5) — expected vendor id
      0x63, 0x92, 0x83, 0x0e, // bne  x7, x8, fail — wrong vendor id: park in fail
      0x23, 0x28, 0x0a, 0x06, // sw   x0, 0x70(x20) — Status = 0: reset the device
      0x93, 0x03, 0x10, 0x00, // addi x7, x0, 1 — 1 = VIRTIO_CONFIG_S_ACKNOWLEDGE
      0x23, 0x28, 0x7a, 0x06, // sw   x7, 0x70(x20) — Status = 1: acknowledge
      0x93, 0x83, 0x23, 0x00, // addi x7, x7, 2 — 3 = ACKNOWLEDGE | DRIVER
      0x23, 0x28, 0x7a, 0x06, // sw   x7, 0x70(x20) — Status = 3: driver attached
      0x23, 0x20, 0x0a, 0x02, // sw   x0, 0x20(x20) — DriverFeatures = 0 (selector 0, low word)
      0x93, 0x03, 0xb0, 0x00, // addi x7, x0, 11 — 0xb = ACKNOWLEDGE | DRIVER | FEATURES_OK
      0x23, 0x28, 0x7a, 0x06, // sw   x7, 0x70(x20) — Status = 0xb: features negotiated
      0x83, 0x23, 0x0a, 0x07, // lw   x7, 0x70(x20) — re-read Status
      0x93, 0xf3, 0x83, 0x00, // andi x7, x7, 8 — keep the FEATURES_OK bit
      0x63, 0x8c, 0x03, 0x0a, // beq  x7, x0, fail — features not accepted: park in fail
      0x93, 0x03, 0xf0, 0x00, // addi x7, x0, 15 — 0xf = all four status bits
      0x23, 0x28, 0x7a, 0x06, // sw   x7, 0x70(x20) — Status = 0xf: driver ok, may notify
      0x83, 0x23, 0x4a, 0x03, // lw   x7, 0x34(x20) — QueueNumMax
      0x13, 0x04, 0x80, 0x00, // addi x8, x0, 8 — xv6 queue depth NUM = 8
      0x63, 0x92, 0x83, 0x0a, // bne  x7, x8, fail — queue smaller than 8: park in fail
      0x23, 0x2c, 0x8a, 0x02, // sw   x8, 0x38(x20) — QueueNum = 8
      0x13, 0x83, 0x02, 0x13, // addi x6, x5, 304 — x6 = descriptor table address
      0x23, 0x20, 0x6a, 0x08, // sw   x6, 0x80(x20) — QueueDescLow
      0x23, 0x22, 0x0a, 0x08, // sw   x0, 0x84(x20) — QueueDescHigh = 0
      0x13, 0x83, 0x02, 0x19, // addi x6, x5, 400 — x6 = avail ring address
      0x23, 0x28, 0x6a, 0x08, // sw   x6, 0x90(x20) — QueueDriverLow
      0x23, 0x2a, 0x0a, 0x08, // sw   x0, 0x94(x20) — QueueDriverHigh = 0
      0x13, 0x83, 0x82, 0x1a, // addi x6, x5, 424 — x6 = used ring address
      0x23, 0x20, 0x6a, 0x0a, // sw   x6, 0xa0(x20) — QueueDeviceLow
      0x23, 0x22, 0x0a, 0x0a, // sw   x0, 0xa4(x20) — QueueDeviceHigh = 0
      0x93, 0x03, 0x10, 0x00, // addi x7, x0, 1 — 1 = queue live
      0x23, 0x22, 0x7a, 0x04, // sw   x7, 0x44(x20) — QueueReady = 1
      0x13, 0x83, 0x02, 0x19, // addi x6, x5, 400 — x6 = avail ring address
      0x93, 0x03, 0x10, 0x00, // addi x7, x0, 1 — publish head 0 (ring[0] static 0)
      0x23, 0x11, 0x73, 0x00, // sh   x7, 0x2(x6) — avail->idx = 1 (u16, not sw)
      0x0f, 0x00, 0xf0, 0x0f, // fence iorw, iorw — publish guest stores before the notify
      0x23, 0x28, 0x0a, 0x04, // sw   x0, 0x50(x20) — QueueNotify(0): submit to async disk worker
      0x13, 0x83, 0x82, 0x1a, // addi x6, x5, 424 — x6 = used ring address
      0x83, 0x13, 0x23, 0x00, // lh   x7, 0x2(x6) — used->idx (u16)
      0xe3, 0x8c, 0x03, 0xfe, // beq  x7, x0, wait — spin until the used entry lands
      0x13, 0x83, 0x02, 0x20, // addi x6, x5, 512 — x6 = status byte address
      0x83, 0x03, 0x03, 0x00, // lb   x7, 0(x6) — device status byte (0xff sentinel)
      0x63, 0x94, 0x03, 0x04, // bne  x7, x0, fail — device never wrote 0: park in fail
      0x13, 0x83, 0x02, 0x60, // addi x6, x5, 1536 — x6 = block buffer (RAM + 0x600)
      0x83, 0x33, 0x03, 0x00, // ld   x7, 0(x6) — first 8 read bytes
      0x03, 0xb4, 0x02, 0x18, // ld   x8, 0x180(x5) — expected head bytes "ya-risc-"
      0x63, 0x9c, 0x83, 0x02, // bne  x7, x8, fail — wrong head bytes: park in fail
      0x83, 0x33, 0x83, 0x3f, // ld   x7, 0x3f8(x6) — last 8 read bytes (offset 1016)
      0x03, 0xb4, 0x82, 0x18, // ld   x8, 0x188(x5) — expected tail bytes
      0x63, 0x96, 0x83, 0x02, // bne  x7, x8, fail — wrong tail bytes: park in fail
      0x93, 0x03, 0x60, 0x05, // addi x7, x0, 86 — 86 = 'V'
      0x23, 0x00, 0x75, 0x00, // sb   x7, 0(x10) — print 'V'
      0x93, 0x03, 0x40, 0x04, // addi x7, x0, 68 — 68 = 'D'
      0x23, 0x00, 0x75, 0x00, // sb   x7, 0(x10) — print 'D'
      0x83, 0x05, 0x55, 0x00, // lb   x11, 0x5(x10) — LSR
      0x93, 0xf5, 0x05, 0x04, // andi x11, x11, 64 — LSR.TEMT
      0xe3, 0x8c, 0x05, 0xfe, // beq  x11, x0, drain — spin until the TX queue is drained
      0x93, 0x06, 0x10, 0x00, // addi x13, x0, 1 — syscon poweroff value
      0x23, 0x20, 0xd6, 0x00, // sw   x13, 0(x12) — syscon poweroff (the finisher store)
      0x6f, 0x00, 0x00, 0x00, // jal  x0, 0 — yank-safe spin: the power cut is nondeterministic
      0x63, 0x00, 0x00, 0x00, // beq  x0, x0, fail — fail: spin forever, never print
      0x13, 0x00, 0x00, 0x00, // nop — pad so DESC is 16-byte aligned
      0x13, 0x00, 0x00, 0x00, // nop — pad so DESC is 16-byte aligned
      0x13, 0x00, 0x00, 0x00, // nop — pad so DESC is 16-byte aligned
      0xf0, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, // desc0.addr = 0x800001f0
      0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, // desc0: len=16 flags=1 next=1
      0x00, 0x06, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, // desc1.addr = 0x80000600
      0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0x02, 0x00, // desc1: len=1024 flags=3 next=2
      0x00, 0x02, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, // desc2.addr = 0x80000200
      0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, // desc2: len=1 flags=2 next=0
      0x76, 0x69, 0x72, 0x74, 0x00, 0x00, 0x00, 0x00, // EXP_MAGIC = 0x74726976 ("virt")
      0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // EXP_VERSION = 2
      0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // EXP_DEVICE = 2 (block device)
      0x51, 0x45, 0x4d, 0x55, 0x00, 0x00, 0x00, 0x00, // EXP_VENDOR = 0x554d4551 ("QEMU")
      0x79, 0x61, 0x2d, 0x72, 0x69, 0x73, 0x63, 0x2d, // EXP_HEAD = "ya-risc-" (disk[0..7], LE)
      0x5d, 0x5c, 0x5f, 0x5e, 0x59, 0x58, 0x5b, 0x5a, // EXP_TAIL = disk[1016..1023] tail, LE
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // avail ring +0 (flags/idx/ring zero)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // avail ring +8 (flags/idx/ring zero)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // avail ring +16 (flags/idx/ring zero)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +0 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +8 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +16 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +24 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +32 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +40 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +48 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +56 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +64 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // request header lo: type=0 (IN), reserved=0
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // request header hi: sector=0
      0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // status byte sentinel 0xff (device writes 0)
]);

// prettier-ignore
const interruptImage = new Uint8Array([
      0x97, 0x02, 0x00, 0x00, // auipc x5, 0 — x5 = RAM base 0x8000_0000 (PC-relative)
      0x37, 0x1a, 0x00, 0x10, // lui  x20, 0x10001 — x20 = virtio base 0x1000_1000
      0x37, 0x05, 0x00, 0x10, // lui  x10, 0x10000 — x10 = UART base 0x1000_0000
      0x37, 0x06, 0x10, 0x00, // lui  x12, 0x100 — x12 = syscon base 0x0010_0000
      0xb7, 0x09, 0x00, 0x0c, // lui  x19, 0xc000 — x19 = PLIC base 0x0c00_0000
      0x93, 0x03, 0x10, 0x00, // addi x7, x0, 1 — 1 = nonzero priority
      0x23, 0xa2, 0x79, 0x00, // sw   x7, 0x4(x19) — PLIC priority[1] = 1 (virtio irq)
      0x37, 0x23, 0x00, 0x0c, // lui  x6, 0xc002 — x6 = 0x0c00_2000 (M-context enable word)
      0x93, 0x03, 0x20, 0x00, // addi x7, x0, 2 — bit 1 = source 1 enable
      0x23, 0x20, 0x73, 0x00, // sw   x7, 0(x6) — enable source 1 for machine context
      0xb7, 0x07, 0x20, 0x0c, // lui  x15, 0xc200 — x15 = 0x0c20_0000 (M threshold/claim)
      0x23, 0xa0, 0x07, 0x00, // sw   x0, 0(x15) — M threshold = 0
      0x17, 0x07, 0x00, 0x00, // auipc x14, 0 — PC-relative handler base
      0x13, 0x07, 0xc7, 0x13, // addi x14, x14, 316 — x14 = handler (image + 0x16c)
      0x73, 0x10, 0x57, 0x30, // csrrw x0, 0x305, x14 — mtvec = handler (Direct mode)
      0x93, 0x03, 0x10, 0x00, // addi x7, x0, 1 — 1 << 11 = mie.MEIE (csrrsi zimm is 5 bits)
      0x93, 0x93, 0xb3, 0x00, // slli x7, x7, 11 — mie.MEIE
      0x73, 0x90, 0x43, 0x30, // csrrw x0, 0x304, x7 — enable machine external interrupts
      0x13, 0x00, 0x00, 0x00, // nop — keep global MIE clear until wfi has observed the completion
      0x83, 0x23, 0x0a, 0x00, // lw   x7, 0(x20) — probe MagicValue (want 0x74726976)
      0x03, 0xa4, 0x02, 0x1d, // lw   x8, 0x1d0(x5) — expected magic from the data section
      0x63, 0x9a, 0x83, 0x10, // bne  x7, x8, fail — wrong magic: park in fail
      0x83, 0x23, 0x4a, 0x00, // lw   x7, 0x4(x20) — probe Version (want 2)
      0x03, 0xa4, 0x82, 0x1d, // lw   x8, 0x1d8(x5) — expected version
      0x63, 0x94, 0x83, 0x10, // bne  x7, x8, fail — wrong version: park in fail
      0x83, 0x23, 0x8a, 0x00, // lw   x7, 0x8(x20) — probe DeviceID (want 2, block device)
      0x03, 0xa4, 0x02, 0x1e, // lw   x8, 0x1e0(x5) — expected device id
      0x63, 0x9e, 0x83, 0x0e, // bne  x7, x8, fail — wrong device id: park in fail
      0x83, 0x23, 0xca, 0x00, // lw   x7, 0xc(x20) — probe VendorID (want 0x554d4551)
      0x03, 0xa4, 0x82, 0x1e, // lw   x8, 0x1e8(x5) — expected vendor id
      0x63, 0x98, 0x83, 0x0e, // bne  x7, x8, fail — wrong vendor id: park in fail
      0x23, 0x28, 0x0a, 0x06, // sw   x0, 0x70(x20) — Status = 0: reset the device
      0x93, 0x03, 0x10, 0x00, // addi x7, x0, 1 — 1 = VIRTIO_CONFIG_S_ACKNOWLEDGE
      0x23, 0x28, 0x7a, 0x06, // sw   x7, 0x70(x20) — Status = 1: acknowledge
      0x93, 0x83, 0x23, 0x00, // addi x7, x7, 2 — 3 = ACKNOWLEDGE | DRIVER
      0x23, 0x28, 0x7a, 0x06, // sw   x7, 0x70(x20) — Status = 3: driver attached
      0x23, 0x20, 0x0a, 0x02, // sw   x0, 0x20(x20) — DriverFeatures = 0 (selector 0, low word)
      0x93, 0x03, 0xb0, 0x00, // addi x7, x0, 11 — 0xb = ACKNOWLEDGE | DRIVER | FEATURES_OK
      0x23, 0x28, 0x7a, 0x06, // sw   x7, 0x70(x20) — Status = 0xb: features negotiated
      0x83, 0x23, 0x0a, 0x07, // lw   x7, 0x70(x20) — re-read Status
      0x93, 0xf3, 0x83, 0x00, // andi x7, x7, 8 — keep the FEATURES_OK bit
      0x63, 0x82, 0x03, 0x0c, // beq  x7, x0, fail — features not accepted: park in fail
      0x93, 0x03, 0xf0, 0x00, // addi x7, x0, 15 — 0xf = all four status bits
      0x23, 0x28, 0x7a, 0x06, // sw   x7, 0x70(x20) — Status = 0xf: driver ok, may notify
      0x83, 0x23, 0x4a, 0x03, // lw   x7, 0x34(x20) — QueueNumMax
      0x13, 0x04, 0x80, 0x00, // addi x8, x0, 8 — xv6 queue depth NUM = 8
      0x63, 0x98, 0x83, 0x0a, // bne  x7, x8, fail — queue smaller than 8: park in fail
      0x23, 0x2c, 0x8a, 0x02, // sw   x8, 0x38(x20) — QueueNum = 8
      0x13, 0x83, 0x02, 0x1a, // addi x6, x5, 416 — x6 = descriptor table address
      0x23, 0x20, 0x6a, 0x08, // sw   x6, 0x80(x20) — QueueDescLow
      0x23, 0x22, 0x0a, 0x08, // sw   x0, 0x84(x20) — QueueDescHigh = 0
      0x13, 0x83, 0x02, 0x20, // addi x6, x5, 512 — x6 = avail ring address
      0x23, 0x28, 0x6a, 0x08, // sw   x6, 0x90(x20) — QueueDriverLow
      0x23, 0x2a, 0x0a, 0x08, // sw   x0, 0x94(x20) — QueueDriverHigh = 0
      0x13, 0x83, 0x82, 0x21, // addi x6, x5, 536 — x6 = used ring address
      0x23, 0x20, 0x6a, 0x0a, // sw   x6, 0xa0(x20) — QueueDeviceLow
      0x23, 0x22, 0x0a, 0x0a, // sw   x0, 0xa4(x20) — QueueDeviceHigh = 0
      0x93, 0x03, 0x10, 0x00, // addi x7, x0, 1 — 1 = queue live
      0x23, 0x22, 0x7a, 0x04, // sw   x7, 0x44(x20) — QueueReady = 1
      0x13, 0x83, 0x02, 0x20, // addi x6, x5, 512 — x6 = avail ring address
      0x93, 0x03, 0x10, 0x00, // addi x7, x0, 1 — publish head 0 (ring[0] is statically 0)
      0x23, 0x11, 0x73, 0x00, // sh   x7, 0x2(x6) — avail->idx = 1 (u16, not sw)
      0x0f, 0x00, 0xf0, 0x0f, // fence iorw, iorw — publish guest stores before the notify
      0x23, 0x28, 0x0a, 0x04, // sw   x0, 0x50(x20) — QueueNotify(0): submit to async disk worker
      0x73, 0x00, 0x50, 0x10, // wfi — wait for the enabled disk interrupt, even with global MIE clear
      0x73, 0x60, 0x04, 0x30, // csrrsi x0, 0x300, 8 — enable MIE; take the pending interrupt
      0x13, 0x00, 0x00, 0x00, // nop — handler has run before this instruction
      0x83, 0xa3, 0x02, 0x28, // lw   x7, 0x280(x5) — the claimed PLIC source id
      0x13, 0x04, 0x10, 0x00, // addi x8, x0, 1 — 1 = virtio is PLIC source 1
      0x63, 0x9a, 0x83, 0x04, // bne  x7, x8, fail — wrong claimed source: park in fail
      0x13, 0x83, 0x02, 0x27, // addi x6, x5, 624 — x6 = status byte address
      0x83, 0x03, 0x03, 0x00, // lb   x7, 0(x6) — device status byte (0xff sentinel)
      0x63, 0x94, 0x03, 0x04, // bne  x7, x0, fail — device never wrote 0: park in fail
      0x13, 0x83, 0x02, 0x60, // addi x6, x5, 1536 — x6 = block buffer (RAM + 0x600)
      0x83, 0x33, 0x03, 0x00, // ld   x7, 0(x6) — first 8 read bytes
      0x03, 0xb4, 0x02, 0x1f, // ld   x8, 0x1f0(x5) — expected head bytes "ya-risc-"
      0x63, 0x9c, 0x83, 0x02, // bne  x7, x8, fail — wrong head bytes: park in fail
      0x83, 0x33, 0x83, 0x3f, // ld   x7, 0x3f8(x6) — last 8 read bytes (offset 1016)
      0x03, 0xb4, 0x82, 0x1f, // ld   x8, 0x1f8(x5) — expected tail bytes
      0x63, 0x96, 0x83, 0x02, // bne  x7, x8, fail — wrong tail bytes: park in fail
      0x93, 0x03, 0x60, 0x05, // addi x7, x0, 86 — 86 = 'V'
      0x23, 0x00, 0x75, 0x00, // sb   x7, 0(x10) — print 'V'
      0x93, 0x03, 0x40, 0x04, // addi x7, x0, 68 — 68 = 'D'
      0x23, 0x00, 0x75, 0x00, // sb   x7, 0(x10) — print 'D'
      0x83, 0x05, 0x55, 0x00, // lb   x11, 0x5(x10) — LSR
      0x93, 0xf5, 0x05, 0x04, // andi x11, x11, 64 — LSR.TEMT
      0xe3, 0x8c, 0x05, 0xfe, // beq  x11, x0, drain — spin until the TX queue is drained
      0x93, 0x06, 0x10, 0x00, // addi x13, x0, 1 — syscon poweroff value
      0x23, 0x20, 0xd6, 0x00, // sw   x13, 0(x12) — syscon poweroff (the finisher store)
      0x6f, 0x00, 0x00, 0x00, // jal  x0, 0 — yank-safe spin: the power cut is nondeterministic
      0x63, 0x00, 0x00, 0x00, // beq  x0, x0, fail — fail: spin forever, never print
      0x83, 0xa3, 0x47, 0x00, // lw   x7, 0x4(x15) — claim: id out, pending clears, MEIP drops
      0x03, 0x24, 0x0a, 0x06, // lw   x8, 0x60(x20) — InterruptStatus
      0x13, 0x74, 0x14, 0x00, // andi x8, x8, 1 — bit 0: used-buffer notification
      0x23, 0x22, 0x8a, 0x06, // sw   x8, 0x64(x20) — InterruptACK bit 0: deassert PLIC source 1
      0x23, 0xa2, 0x77, 0x00, // sw   x7, 0x4(x15) — complete the claimed source
      0x13, 0x83, 0x02, 0x28, // addi x6, x5, 640 — x6 = FLAG_ID word address
      0x23, 0x20, 0x73, 0x00, // sw   x7, 0(x6) — record the claimed source id
      0x13, 0x83, 0x82, 0x27, // addi x6, x5, 632 — x6 = FLAG word address
      0x93, 0x03, 0x10, 0x00, // addi x7, x0, 1 — 1 = completion flag
      0x23, 0x20, 0x73, 0x00, // sw   x7, 0(x6) — FLAG = 1: wake the main flow
      0x73, 0x00, 0x20, 0x30, // mret — return after enabling global interrupts
      0x13, 0x00, 0x00, 0x00, // nop — pad so DESC is 16-byte aligned
      0x13, 0x00, 0x00, 0x00, // nop — pad so DESC is 16-byte aligned
      0x60, 0x02, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, // desc0.addr = 0x80000260
      0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, // desc0: len=16 flags=1 next=1
      0x00, 0x06, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, // desc1.addr = 0x80000600
      0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0x02, 0x00, // desc1: len=1024 flags=3 next=2
      0x70, 0x02, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, // desc2.addr = 0x80000270
      0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, // desc2: len=1 flags=2 next=0
      0x76, 0x69, 0x72, 0x74, 0x00, 0x00, 0x00, 0x00, // EXP_MAGIC = 0x74726976 ("virt")
      0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // EXP_VERSION = 2
      0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // EXP_DEVICE = 2 (block device)
      0x51, 0x45, 0x4d, 0x55, 0x00, 0x00, 0x00, 0x00, // EXP_VENDOR = 0x554d4551 ("QEMU")
      0x79, 0x61, 0x2d, 0x72, 0x69, 0x73, 0x63, 0x2d, // EXP_HEAD = "ya-risc-" (disk[0..7], LE)
      0x5d, 0x5c, 0x5f, 0x5e, 0x59, 0x58, 0x5b, 0x5a, // EXP_TAIL = disk[1016..1023] tail, LE
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // avail ring +0 (flags/idx/ring zero)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // avail ring +8 (flags/idx/ring zero)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // avail ring +16 (flags/idx/ring zero)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +0 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +8 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +16 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +24 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +32 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +40 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +48 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +56 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // used ring +64 (device writes at runtime)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // request header lo: type=0 (IN), reserved=0
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // request header hi: sector=0
      0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // status byte sentinel 0xff (device writes 0)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // FLAG: handler completion flag
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // FLAG_ID: claimed PLIC source id
]);

// prettier-ignore
const maskedOutImage = new Uint8Array([
  0x97, 0x02, 0x00, 0x00, // auipc x5, 0 — RAM base
  0x37, 0x1a, 0x00, 0x10, // lui x20, 0x10001 — virtio base
  0x37, 0x05, 0x00, 0x10, // lui x10, 0x10000 — UART base
  0x23, 0x28, 0x0a, 0x06, // sw x0, 0x70(x20) — reset
  0x93, 0x03, 0x10, 0x00, // addi x7, x0, 1 — status
  0x23, 0x28, 0x7a, 0x06, // sw x7, 0x70(x20) — status transition
  0x93, 0x03, 0x30, 0x00, // addi x7, x0, 3 — status
  0x23, 0x28, 0x7a, 0x06, // sw x7, 0x70(x20) — status transition
  0x93, 0x03, 0xb0, 0x00, // addi x7, x0, 11 — status
  0x23, 0x28, 0x7a, 0x06, // sw x7, 0x70(x20) — status transition
  0x93, 0x03, 0xf0, 0x00, // addi x7, x0, 15 — status
  0x23, 0x28, 0x7a, 0x06, // sw x7, 0x70(x20) — status transition
  0x93, 0x03, 0x80, 0x00, // addi x7, x0, 8 — queue depth
  0x23, 0x2c, 0x7a, 0x02, // sw x7, 0x38(x20) — QueueNum
  0x13, 0x83, 0x02, 0x08, // addi x6, x5, 128 — queue address
  0x23, 0x20, 0x6a, 0x08, // sw x6, 0x80(x20) — queue address low
  0x13, 0x83, 0x02, 0x0c, // addi x6, x5, 192 — queue address
  0x23, 0x28, 0x6a, 0x08, // sw x6, 0x90(x20) — queue address low
  0x13, 0x83, 0x02, 0x0e, // addi x6, x5, 224 — queue address
  0x23, 0x20, 0x6a, 0x0a, // sw x6, 0xa0(x20) — queue address low
  0x93, 0x03, 0x10, 0x00, // addi x7, x0, 1 — ready
  0x23, 0x22, 0x7a, 0x04, // sw x7, 0x44(x20) — QueueReady
  0x0f, 0x00, 0xf0, 0x0f, // fence iorw, iorw — publish avail and payload
  0x23, 0x28, 0x0a, 0x04, // sw x0, 0x50(x20) — kick OUT
  0x93, 0x03, 0x00, 0x05, // addi x7, x0, 80 — P marker
  0x23, 0x00, 0x75, 0x00, // sb x7, 0(x10) — P before park
  0x73, 0x00, 0x50, 0x10, // wfi — mie remains zero, disk must not resume hart
  0x93, 0x03, 0x80, 0x05, // addi x7, x0, 88 — forbidden X after WFI
  0x23, 0x00, 0x75, 0x00, // sb x7, 0(x10) — must not execute
  0x6f, 0x00, 0x00, 0x00, // jal x0, 0 — parked fallback
  0x00, 0x00, 0x00, 0x00, // alignment to descriptor table
  0x00, 0x00, 0x00, 0x00, // alignment to descriptor table
  0xb0, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, // data at RAM + 128
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, // data at RAM + 136
  0x30, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, // data at RAM + 144
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x02, 0x00, // data at RAM + 152
  0x28, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, // data at RAM + 160
  0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, // data at RAM + 168
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 176
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 184
  0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 192
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 200
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 208
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 216
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 224
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 232
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 240
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 248
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 256
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 264
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 272
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 280
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 288
  0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // data at RAM + 296
  0x69, 0x6e, 0x64, 0x65, 0x70, 0x65, 0x6e, 0x64, // data at RAM + 304
  0x65, 0x6e, 0x74, 0x2d, 0x64, 0x69, 0x73, 0x6b, // data at RAM + 312
]);

/** Instruction region lengths: only these bytes are instructions; data rows are not. */
const POLL_INSTRUCTION_BYTES = 0x130;
const INTERRUPT_INSTRUCTION_BYTES = 0x1a0;

describe('virtio integration (real machine, real disk file, no mocks)', () => {
  describe('guest image decode probe', () => {
    it('decodes every instruction word of all guest images', () => {
      const probe = (image: Uint8Array, instructionBytes: number): void => {
        assert.equal(image.length % 8, 0, 'image must be whole 8-byte rows');
        assert.ok(instructionBytes <= image.length);
        for (let offset = 0; offset < instructionBytes; offset += 4) {
          const word = image.subarray(offset, offset + 4);
          assert.notEqual(bytesToNumber(word), 0, `zero word at image +0x${offset.toString(16)}`);
          const [execute, decodedLength] = decode(word);
          assert.equal(typeof execute, 'function', `no thunk at image +0x${offset.toString(16)}`);
          assert.deepEqual(
            decodedLength,
            FOUR_BYTES,
            `bad length at image +0x${offset.toString(16)}`
          );
        }
      };
      probe(pollImage, POLL_INSTRUCTION_BYTES);
      probe(interruptImage, INTERRUPT_INSTRUCTION_BYTES);
      probe(maskedOutImage, 120);
    });
  });

  it(
    'writes a real file with mie masked and does not resume after WFI',
    { timeout: 20000 },
    async () => {
      const { diskPath, remove } = createTempDisk();
      try {
        await runGuest(
          maskedOutImage,
          async ({ output, emulator }) => {
            await output.waitForByteCount(1);
            const expected = new TextEncoder().encode('independent-disk');
            let completed = false;
            for (let i = 0; i < 1000; i++) {
              if (
                new Uint8Array(readFileSync(diskPath))
                  .subarray(0, 16)
                  .every((b, j) => b === expected[j])
              ) {
                completed = true;
                break;
              }
              await new Promise<void>((resolve) => setTimeout(resolve, 1));
            }
            assert.equal(completed, true, 'independent OUT write must reach backing file');
            await emulator.stop();
            await settleEmulator(emulator);
            assert.equal(output.text(), 'P', 'masked disk completion must not resume WFI');
            // File I/O may finish before actual parking; the no-hart device test proves ownership.
          },
          { diskImagePath: diskPath }
        );
      } finally {
        remove();
      }
    }
  );

  it(
    'negotiates virtio-mmio, reads a block through the queue, verifies it, and powers off',
    { timeout: 20_000 },
    async () => {
      const { diskPath, remove } = createTempDisk();
      try {
        await runGuest(
          pollImage,
          ({ output, emulator }) => expectPrintThenPoweroff(output, emulator, 'VD'),
          { diskImagePath: diskPath }
        );
        // The IN request must not have written the disk back.
        assert.deepEqual(new Uint8Array(readFileSync(diskPath)), buildDiskBytes());
      } finally {
        remove();
      }
    }
  );

  it(
    'wakes wfi and delivers the completion as a machine external interrupt from PLIC source 1',
    { timeout: 20_000 },
    async () => {
      const { diskPath, remove } = createTempDisk();
      try {
        await runGuest(
          interruptImage,
          ({ output, emulator }) => expectPrintThenPoweroff(output, emulator, 'VD'),
          { diskImagePath: diskPath }
        );
        assert.deepEqual(new Uint8Array(readFileSync(diskPath)), buildDiskBytes());
      } finally {
        remove();
      }
    }
  );
});
