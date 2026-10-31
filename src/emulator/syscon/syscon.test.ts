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
import { loadBytes, storeBytes } from '#emulator/memory';
import {
  SYSCON_POWEROFF_OFFSET,
  SYSCON_POWEROFF_VALUE,
  SYSCON_REBOOT_OFFSET,
  SYSCON_REBOOT_VALUE,
  SYSCON_REGION_ID,
  cancelSysconWatch,
  watchSyscon,
} from '#emulator/syscon';
import createTestMemory from '#test/guest-memory';
import { addBytes, unsignedNumberToBytes } from '#utils/bytes';

const registerBytes = (value: number): Uint8Array =>
  unsignedNumberToBytes(new Uint8Array(8), value).subarray(0, 4);

const sysconAddress = (memory: ReturnType<typeof createTestMemory>, offset: number) => {
  const region = memory.regions.get(SYSCON_REGION_ID);
  if (region === undefined || region.guestAddress === null) {
    throw new Error(`Memory region '${SYSCON_REGION_ID}' is not a guest window.`);
  }
  return addBytes(
    new Uint8Array(8),
    region.guestAddress,
    unsignedNumberToBytes(new Uint8Array(8), offset)
  );
};

describe('syscon', () => {
  it('a poweroff store wakes the host watch', async () => {
    const memory = createTestMemory(64n);
    const pending = watchSyscon(memory);
    storeBytes({
      memory,
      address: sysconAddress(memory, SYSCON_POWEROFF_OFFSET),
      source: registerBytes(SYSCON_POWEROFF_VALUE),
      byteLength: 4,
    });
    assert.equal(await pending, 'poweroff');
  });

  it('a reboot store wakes the host watch', async () => {
    const memory = createTestMemory(64n);
    const pending = watchSyscon(memory);
    storeBytes({
      memory,
      address: sysconAddress(memory, SYSCON_REBOOT_OFFSET),
      source: registerBytes(SYSCON_REBOOT_VALUE),
      byteLength: 4,
    });
    assert.equal(await pending, 'reboot');
  });

  it('partial and straddling stores update each register word without tearing', () => {
    const memory = createTestMemory(64n);

    // A partial store updates one register without tearing the other bytes.
    storeBytes({
      memory,
      address: sysconAddress(memory, SYSCON_POWEROFF_OFFSET),
      source: Uint8Array.of(0x01, 0x02, 0x03, 0x04),
      byteLength: 4,
    });
    storeBytes({
      memory,
      address: sysconAddress(memory, 1),
      source: Uint8Array.of(0xaa),
      byteLength: 1,
    });
    const partial = new Uint8Array(4);
    loadBytes({
      destination: partial,
      memory,
      address: sysconAddress(memory, SYSCON_POWEROFF_OFFSET),
      byteLength: 4,
    });
    assert.deepEqual(partial, Uint8Array.of(0x01, 0xaa, 0x03, 0x04));

    // A store straddling both registers updates each word.
    const word = Uint8Array.of(0x01, 0x02, 0x03, 0x04);
    storeBytes({
      memory,
      address: sysconAddress(memory, SYSCON_POWEROFF_OFFSET),
      source: word,
      byteLength: 4,
    });
    storeBytes({
      memory,
      address: sysconAddress(memory, SYSCON_REBOOT_OFFSET),
      source: word,
      byteLength: 4,
    });
    storeBytes({
      memory,
      address: sysconAddress(memory, 3),
      source: Uint8Array.of(0xee, 0xff),
      byteLength: 2,
    });
    const poweroff = new Uint8Array(4);
    const reboot = new Uint8Array(4);
    loadBytes({
      destination: poweroff,
      memory,
      address: sysconAddress(memory, SYSCON_POWEROFF_OFFSET),
      byteLength: 4,
    });
    loadBytes({
      destination: reboot,
      memory,
      address: sysconAddress(memory, SYSCON_REBOOT_OFFSET),
      byteLength: 4,
    });
    assert.deepEqual(poweroff, Uint8Array.of(0x01, 0x02, 0x03, 0xee));
    assert.deepEqual(reboot, Uint8Array.of(0xff, 0x02, 0x03, 0x04));
  });

  it('another value does not request poweroff, and the register reads back', async () => {
    const memory = createTestMemory(64n);
    storeBytes({
      memory,
      address: sysconAddress(memory, SYSCON_POWEROFF_OFFSET),
      source: registerBytes(0),
      byteLength: 4,
    });
    const destination = new Uint8Array(4);
    loadBytes({
      destination,
      memory,
      address: sysconAddress(memory, SYSCON_POWEROFF_OFFSET),
      byteLength: 4,
    });
    assert.deepEqual(destination, registerBytes(0));
    const pending = watchSyscon(memory);
    cancelSysconWatch(memory);
    assert.equal(await pending, 'idle');
  });

});
