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
 * RISC-V boot handoff into the hart before the first fetch.
 * `a0` (`x10`) is `mhartid`. `a1` (`x11`) is the guest physical address of the device tree,
 * or zero when that address is `null`.
 */

import {
  MHARTID,
  snapshotControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#emulator/cpu/registers';
import type { Registers } from '#emulator/cpu/types';
import type { ReadonlyUint8Array } from '#types';

const A0 = 10;
const A1 = 11;

const applyBootHandoff = (
  registers: Registers,
  deviceTreeAddress: ReadonlyUint8Array | null
): void => {
  writeGeneralPurposeRegister(registers, A0, snapshotControlAndStatusRegister(registers, MHARTID));
  writeGeneralPurposeRegister(registers, A1, deviceTreeAddress ?? new Uint8Array(8));
};

export default applyBootHandoff;
