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
import { describe, it } from 'node:test';
import testMemory from '#test/guest-memory';
import {
  initializeClint,
  isClintSupervisorTimerPending,
  setClintStimecmpMirror,
  tickClint,
} from '#emulator/clint';
import { loadIrqLevel, IRQ_LEVEL_STIP } from '#emulator/irq-level';
import { storeBytes, type Memory } from '#emulator/memory';
import { unsignedBigIntToBytes } from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';

/** CLINT `mtime` guest address (test map). */
const CLINT_MTIME = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_bff8n) as ReadonlyUint8Array;
/** `stimecmp` mirror value that never expires (matches the CSR reset value). */
const ALL_ONES = unsignedBigIntToBytes(
  new Uint8Array(8),
  0xffff_ffff_ffff_ffffn
) as ReadonlyUint8Array;

/** An 8-byte little-endian compare value. */
const timeBytes = (value: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), value);

/**
 * Store `mtime` through the guest window. The store reseats the epoch so a following `tickClint`
 * reproduces the seeded value instead of reading the host clock, which keeps these cases
 * deterministic.
 */
const seedMtime = (memory: Memory, mtime: bigint): void => {
  storeBytes({ memory, address: CLINT_MTIME, source: timeBytes(mtime), byteLength: 8 });
};

describe('clint supervisor timer wire', () => {
  it('asserts the wire and the irq-level bit while mtime >= stimecmp', () => {
    const memory = testMemory(256n);

    setClintStimecmpMirror(memory, timeBytes(0n));
    assert.equal(isClintSupervisorTimerPending(memory), true);
    assert.notEqual(loadIrqLevel(memory) & IRQ_LEVEL_STIP, 0);
  });

  it('raising stimecmp above mtime clears the wire without waiting for a tick', () => {
    const memory = testMemory(256n);
    setClintStimecmpMirror(memory, timeBytes(0n));
    assert.equal(isClintSupervisorTimerPending(memory), true);

    setClintStimecmpMirror(memory, timeBytes(1n));
    // The publication re-derives both wires itself; no `tickClint` in between.
    assert.equal(isClintSupervisorTimerPending(memory), false);
    assert.equal(loadIrqLevel(memory) & IRQ_LEVEL_STIP, 0);
  });

  it('leaves the wires alone when the mirror already holds the value', () => {
    const memory = testMemory(256n);
    setClintStimecmpMirror(memory, timeBytes(1n));
    assert.equal(isClintSupervisorTimerPending(memory), false);

    // Steady state: the hart republishes the same compare every sample pass, and that path
    // returns without touching either wire.
    setClintStimecmpMirror(memory, timeBytes(1n));
    assert.equal(isClintSupervisorTimerPending(memory), false);
    assert.equal(loadIrqLevel(memory) & IRQ_LEVEL_STIP, 0);

    // `mtime` is what asserts the wire: seed it past the compare (the guest store re-derives),
    // then confirm the timebase tick keeps the compare expired.
    seedMtime(memory, 2n);
    tickClint(memory);
    assert.equal(isClintSupervisorTimerPending(memory), true);
    assert.notEqual(loadIrqLevel(memory) & IRQ_LEVEL_STIP, 0);
  });

  it('resets the stimecmp mirror to all-ones so nothing is pending', () => {
    const memory = testMemory(256n);
    setClintStimecmpMirror(memory, timeBytes(0n));
    assert.equal(isClintSupervisorTimerPending(memory), true);

    initializeClint(memory, 10_000_000n);
    assert.equal(isClintSupervisorTimerPending(memory), false);

    // `mtime` ahead of zero: only an all-ones mirror keeps the wire low, and re-publishing
    // all-ones is a no-op exactly when the reset already wrote it.
    seedMtime(memory, 5n);
    setClintStimecmpMirror(memory, ALL_ONES);
    assert.equal(isClintSupervisorTimerPending(memory), false);
  });
});
