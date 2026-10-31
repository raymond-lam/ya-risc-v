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
 * Syscon region — guest register window plus a host-only request word.
 *
 * Guest (dense prefix). Each register is one atomic 32-bit word, so two harts
 * cannot tear a store:
 *   +0  poweroff register (4 bytes, little-endian)
 *   +4  reboot register (4 bytes, little-endian)
 *
 * Host-only tail:
 *   +8  request Int32 (`0` idle, `1` poweroff, `2` reboot, `3` watch cancelled).
 *       Cancellation is a compare-exchange from idle only, so it can never
 *       overwrite a live poweroff/reboot request (see `cancelSysconWatch`).
 */

import type { Memory } from '#emulator/memory';
import { WAKE_HOST_SIZE, publishWakeLevel, waitWake } from '#emulator/wake';
import type { ReadonlyUint8Array } from '#types';
import { atomicLoad32, atomicUpdate32 } from '#utils/atomics';
import { bytesToInt32Array } from '#utils/bytes';
import { bigIntAsNumber } from '#utils/int';

/** Packed-region id for the syscon (`createMemory` / `regions.get`). */
const SYSCON_REGION_ID = 'syscon';

/** Guest-visible register window (dense prefix of this region). */
const SYSCON_GUEST_BYTE_LENGTH = 8n;

/** Byte offset of the poweroff register inside the guest window. */
const SYSCON_POWEROFF_OFFSET = 0;

/** Byte offset of the reboot register inside the guest window. */
const SYSCON_REBOOT_OFFSET = 4;

/** Little-endian value `syscon-poweroff` writes. */
const SYSCON_POWEROFF_VALUE = 1;

/** Little-endian value `syscon-reboot` writes. */
const SYSCON_REBOOT_VALUE = 1;

/** Relative host offset of the request Int32. */
const SYSCON_WAKE_OFFSET = 8;

/** Contiguous host slab (registers + request word). */
const SYSCON_HOST_BYTE_LENGTH = BigInt(SYSCON_WAKE_OFFSET + WAKE_HOST_SIZE);

const SYSCON_REGISTER_BYTES = 4;
const SYSCON_REGISTER_COUNT = 2;

const SYSCON_REQUEST_IDLE = 0;
const SYSCON_REQUEST_POWEROFF = 1;
const SYSCON_REQUEST_REBOOT = 2;
const SYSCON_REQUEST_STOPPED = 3;

const sysconRegion = (memory: Memory) => {
  const region = memory.regions.get(SYSCON_REGION_ID);
  if (region === undefined) {
    throw new Error(`Memory region '${SYSCON_REGION_ID}' is not packed.`);
  }
  if (region.guestAddress === null) {
    throw new Error(`Memory region '${SYSCON_REGION_ID}' is host-only; expected a guest window.`);
  }
  return region;
};

const sysconHostIndex = (memory: Memory): number => bigIntAsNumber(sysconRegion(memory).hostIndex);

const registerMatches = (bytes: Uint8Array, index: number, value: number): boolean =>
  atomicLoad32({ bytes, index }) === value;

/**
 * Bytes of this access that fall inside one register.
 * `mask` and `value` are little-endian bits of that 32-bit word.
 */
const registerUpdate = (
  offset: number,
  source: ReadonlyUint8Array,
  byteLength: number,
  wordOffset: number
): { mask: number; value: number } => {
  const window = Number(SYSCON_GUEST_BYTE_LENGTH);
  let mask = 0;
  let value = 0;
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const registerOffset = offset + byteIndex;
    if (registerOffset < wordOffset || registerOffset >= wordOffset + SYSCON_REGISTER_BYTES) {
      continue;
    }
    if (registerOffset < 0 || registerOffset >= window) {
      continue;
    }
    const shift = (registerOffset - wordOffset) * 8;
    mask |= 0xff << shift;
    value |= ((source[byteIndex] ?? 0) & 0xff) << shift;
  }
  return { mask: mask >>> 0, value: value >>> 0 };
};

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

/** Guest load of `byteLength` syscon bytes starting at `offset`. */
const loadBytesFromSyscon = ({
  destination,
  memory,
  offset,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  byteLength: number;
}): void => {
  const base = sysconHostIndex(memory);
  const start = Number(offset);
  const window = Number(SYSCON_GUEST_BYTE_LENGTH);
  const words = new Array<number | undefined>(SYSCON_REGISTER_COUNT);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const registerOffset = start + byteIndex;
    if (registerOffset < 0 || registerOffset >= window) {
      destination[byteIndex] = 0;
      continue;
    }
    const wordIndex = registerOffset >>> 2;
    let word = words[wordIndex];
    if (word === undefined) {
      word = atomicLoad32({ bytes: memory.bytes, index: base + wordIndex * SYSCON_REGISTER_BYTES });
      words[wordIndex] = word;
    }
    destination[byteIndex] = (word >>> ((registerOffset & 3) * 8)) & 0xff;
  }
};

/** Guest store of `byteLength` syscon bytes starting at `offset`. */
const storeBytesToSyscon = ({
  memory,
  offset,
  source,
  byteLength,
}: {
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  source: ReadonlyUint8Array;
  byteLength: number;
}): void => {
  const base = sysconHostIndex(memory);
  const start = Number(offset);
  for (let wordIndex = 0; wordIndex < SYSCON_REGISTER_COUNT; wordIndex += 1) {
    const wordOffset = wordIndex * SYSCON_REGISTER_BYTES;
    const update = registerUpdate(start, source, byteLength, wordOffset);
    if (update.mask === 0) {
      continue;
    }
    atomicUpdate32({
      bytes: memory.bytes,
      index: base + wordOffset,
      mask: update.mask,
      value: update.value,
    });
  }
  publishSysconRequest(memory);
};

export {
  SYSCON_GUEST_BYTE_LENGTH,
  SYSCON_HOST_BYTE_LENGTH,
  SYSCON_POWEROFF_OFFSET,
  SYSCON_POWEROFF_VALUE,
  SYSCON_REBOOT_OFFSET,
  SYSCON_REBOOT_VALUE,
  SYSCON_REGION_ID,
  cancelSysconWatch,
  loadBytesFromSyscon,
  storeBytesToSyscon,
  watchSyscon,
};
