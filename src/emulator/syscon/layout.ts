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
import { WAKE_HOST_SIZE } from '#emulator/wake';
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

export {
  SYSCON_GUEST_BYTE_LENGTH,
  SYSCON_HOST_BYTE_LENGTH,
  SYSCON_POWEROFF_OFFSET,
  SYSCON_POWEROFF_VALUE,
  SYSCON_REBOOT_OFFSET,
  SYSCON_REBOOT_VALUE,
  SYSCON_REGION_ID,
  SYSCON_REGISTER_BYTES,
  SYSCON_REGISTER_COUNT,
  SYSCON_REQUEST_IDLE,
  SYSCON_REQUEST_POWEROFF,
  SYSCON_REQUEST_REBOOT,
  SYSCON_REQUEST_STOPPED,
  SYSCON_WAKE_OFFSET,
  sysconHostIndex,
};
