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
 * CLINT device public API — guest MMIO, timebase init / tick, and IRQ wire samples.
 * Timebase Worker host is `#emulator/timer`.
 */

import { readClintMtimeBytes, resetClintTimebase, tickClint } from '#emulator/clint/time';
import {
  isClintMachineSoftwarePending,
  isClintMachineTimerPending,
  setClintSoftwareWire,
  setClintTimerWire,
} from '#emulator/clint/wires';
import type { Memory } from '#emulator/memory';

export {
  CLINT_GUEST_BYTE_LENGTH,
  CLINT_HOST_BYTE_LENGTH,
  CLINT_REGION_ID,
} from '#emulator/clint/layout';
export { loadBytesFromClint, storeBytesToClint } from '#emulator/clint/memory';

/** Initialize CLINT: timebase reset, both IRQ wires clear. */
const initializeClint = (memory: Memory): void => {
  resetClintTimebase(memory);
  setClintTimerWire(memory, false);
  setClintSoftwareWire(memory, false);
};

export {
  initializeClint,
  tickClint,
  readClintMtimeBytes,
  isClintMachineSoftwarePending,
  isClintMachineTimerPending,
};
