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
 * Machine-level regression tests for the terminal drain fix: bytes accepted into
 * the UART TX ring must survive teardown and reach the host stream instead of
 * being discarded mid-flight. The shared boot/teardown harness lives in
 * `#test/integration-harness`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { EmulatorHandle } from '#emulator';
import { runGuest, settleEmulator, type GuestOutput } from '#test/integration-harness';

describe('emulator integration (TX-ring drain, real machine, no mocks)', () => {
  /**
   * Burst image: stores exactly 16 'A' bytes to THR — enough to fill the UART TX
   * ring (capacity 16) — with no LSR polling, then finishes. The syscon variant
   * powers off from the guest; the host variant lets the test call
   * `emulator.stop()` while the ring is still full. Both prove that bytes accepted
   * into the TX ring survive teardown and drain to the host stream instead of
   * being discarded mid-flight.
   */
  const burstImage = (poweroff: boolean): Uint8Array => {
    const tail = poweroff
      ? [
          0x37,
          0x06,
          0x10,
          0x00, // lui  x12, 0x100 — syscon base 0x0010_0000
          0x93,
          0x06,
          0x10,
          0x00, // addi x13, x0, 1 — syscon poweroff value
          0x23,
          0x20,
          0xd6,
          0x00, // sw   x13, 0(x12) — syscon poweroff (the finisher store)
        ]
      : [];
    // prettier-ignore
    return new Uint8Array([
      0x37, 0x05, 0x00, 0x10, // lui  x10, 0x10000 — UART base 0x1000_0000
      0x93, 0x04, 0x10, 0x04, // addi x9, x0, 65 — 65 = 'A'
      0x93, 0x05, 0x00, 0x01, // addi x11, x0, 16 — fill the TX ring exactly
      0x23, 0x00, 0x95, 0x00, // loop: sb x9, 0(x10) — push one 'A'
      0x93, 0x85, 0xf5, 0xff, // addi x11, x11, -1 — one byte fewer
      0xe3, 0x9c, 0x05, 0xfe, // bne  x11, x0, -8 — back to loop
      ...tail,
      0x6f, 0x00, 0x00, 0x00, // jal  x0, 0 — yank-safe spin: the power cut is nondeterministic
    ]);
  };

  const BURST = 'A'.repeat(16);

  /** Run the burst image, run `body`, then assert the whole ring drained. */
  const expectFullBurst = async (
    body: (context: { output: GuestOutput; emulator: EmulatorHandle }) => Promise<void>
  ): Promise<void> => {
    await runGuest(burstImage(true), async ({ output, emulator }) => {
      await body({ output, emulator });
      assert.equal(output.text(), BURST);
    });
  };

  it(
    'drains a full TX ring when the guest powers off mid-stream',
    { timeout: 20_000 },
    async () => {
      await expectFullBurst(({ emulator }) => settleEmulator(emulator));
    }
  );

  it(
    'drains a full TX ring when the host stops the emulator mid-stream',
    { timeout: 20_000 },
    async () => {
      await expectFullBurst(async ({ emulator }) => {
        // Give the guest a beat to fill the ring, then stop while it is pending.
        await delay(250);
        emulator.stop();
        await settleEmulator(emulator);
      });
    }
  );
});
