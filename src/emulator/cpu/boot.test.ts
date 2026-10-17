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
import applyBootHandoff from '#emulator/cpu/boot';
import {
  createRegisters,
  MHARTID,
  readGeneralPurposeRegister,
  snapshotControlAndStatusRegister,
} from '#emulator/cpu/registers';
import { unsignedBigIntToBytes } from '#utils/bytes';

describe('applyBootHandoff', () => {
  it('copies mhartid into a0 and the device tree address into a1', () => {
    const registers = createRegisters();
    const deviceTreeAddress = unsignedBigIntToBytes(new Uint8Array(8), 0x87f0_0000n);
    applyBootHandoff(registers, deviceTreeAddress);
    assert.deepEqual(
      readGeneralPurposeRegister(registers, 10),
      snapshotControlAndStatusRegister(registers, MHARTID)
    );
    assert.deepEqual(readGeneralPurposeRegister(registers, 11), deviceTreeAddress);
  });

  it('writes zero to a1 when no device tree is stored', () => {
    const registers = createRegisters();
    applyBootHandoff(registers, null);
    assert.deepEqual(readGeneralPurposeRegister(registers, 11), new Uint8Array(8));
  });
});
