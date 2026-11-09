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

import type { Memory } from '#emulator/memory';
import {
  SYSCON_POWEROFF_OFFSET,
  SYSCON_POWEROFF_VALUE,
  SYSCON_REBOOT_OFFSET,
  SYSCON_REBOOT_VALUE,
  SYSCON_REQUEST_IDLE,
  SYSCON_REQUEST_POWEROFF,
  SYSCON_REQUEST_REBOOT,
  SYSCON_REQUEST_STOPPED,
  SYSCON_WAKE_OFFSET,
  sysconHostIndex,
} from '#emulator/syscon/layout';
import { publishWakeLevel, waitWake } from '#emulator/wake';
import { atomicLoad32 } from '#utils/atomics';
import { bytesToInt32Array } from '#utils/bytes';

const registerMatches = (bytes: Uint8Array, index: number, value: number): boolean =>
  atomicLoad32({ bytes, index }) === value;

/** Publish the request implied by the guest registers, if either magic value is present. */
const publishSysconRequest = (memory: Memory): void => {
  const base = sysconHostIndex(memory);
  const { bytes } = memory;
  let level = SYSCON_REQUEST_IDLE;
  if (registerMatches(bytes, base + SYSCON_POWEROFF_OFFSET, SYSCON_POWEROFF_VALUE)) {
    level = SYSCON_REQUEST_POWEROFF;
  } else if (registerMatches(bytes, base + SYSCON_REBOOT_OFFSET, SYSCON_REBOOT_VALUE)) {
    level = SYSCON_REQUEST_REBOOT;
  }
  if (level === SYSCON_REQUEST_IDLE) {
    return;
  }
  publishWakeLevel({ bytes, index: base + SYSCON_WAKE_OFFSET, level });
};

/**
 * Wait until a guest store requests poweroff or reboot, or until the watch is cancelled.
 * `idle` means `cancelSysconWatch` ran while the word was still idle.
 *
 * Termination interleavings (the loop exits whenever the word reads 1, 2, or 3):
 * - Cancel while parked (word 0): the compare-exchange 0→3 succeeds and notifies, the
 *   waiter wakes, reads 3, and returns `idle` — the normal host-shutdown path.
 * - Cancel between the waiter's load of 0 and its wait: the subsequent wait compares
 *   against `fromLevel` 0, sees 3, and returns immediately (no lost wake); the loop
 *   reads 3 and returns `idle`.
 * - Live request then cancel: the compare-exchange fails (word is 1/2) and the word
 *   survives; the waiter reads 1/2 and returns `poweroff`/`reboot`. It cannot spin:
 *   every nonzero level exits the loop, and the consumer (`Emulator.#watchSyscon`)
 *   returns on its `stopped` flag when cancellation won the race.
 * - Request races a successful cancel: `publishSysconRequest` exchanges the word
 *   3→1/2 and notifies; the waiter reads 1/2 and returns. The guest's own request
 *   wins, which is correct — the guest asked to halt.
 *
 * The only state that parks forever is a word that stays 0 with no future change,
 * i.e. neither a cancel nor a request ever happens.
 */
const watchSyscon = async (memory: Memory): Promise<'poweroff' | 'reboot' | 'idle'> => {
  const index = sysconHostIndex(memory) + SYSCON_WAKE_OFFSET;
  for (;;) {
    const wake = new Int32Array(memory.bytes.buffer, memory.bytes.byteOffset + index, 1);
    const level = Atomics.load(wake, 0);
    if (level === SYSCON_REQUEST_POWEROFF) {
      return 'poweroff';
    }
    if (level === SYSCON_REQUEST_REBOOT) {
      return 'reboot';
    }
    if (level === SYSCON_REQUEST_STOPPED) {
      return 'idle';
    }
    await waitWake({ bytes: memory.bytes, index, fromLevel: level });
  }
};

/**
 * Wake `watchSyscon` so a host shutdown does not leave the wait running.
 *
 * Compare-exchange, not an unconditional store: an unconditional store could overwrite
 * a live poweroff/reboot request (1/2) with cancelled (3) between the guest's store and
 * the host watch reading it, so the guest's own request would be swallowed. Only idle
 * (0) transitions to cancelled; a live request survives cancellation and the watch
 * always observes it.
 */
const cancelSysconWatch = (memory: Memory): void => {
  const index = sysconHostIndex(memory) + SYSCON_WAKE_OFFSET;
  const wake = bytesToInt32Array(memory.bytes, index);
  if (
    Atomics.compareExchange(wake, 0, SYSCON_REQUEST_IDLE, SYSCON_REQUEST_STOPPED) ===
    SYSCON_REQUEST_IDLE
  ) {
    // The transition happened; notify the parked waiter so the watch settles on `idle`.
    Atomics.notify(wake, 0);
  }
};

export { cancelSysconWatch, publishSysconRequest, watchSyscon };
