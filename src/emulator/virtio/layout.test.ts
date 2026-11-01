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
import { initializeVirtio, VIRTIO_HOST_BYTE_LENGTH, VIRTIO_REGION_ID } from '#emulator/virtio';
import {
  VIRTIO_HOST_DEVICE_PRESENT,
  loadVirtioShadowU32,
  virtioOffsetToLocation,
  type VirtioRegisterKind,
} from '#emulator/virtio/layout';
import { bigIntAsNumber } from '#utils/int';
import createTestMemory from '#test/guest-memory';

const LIVE_REGISTERS: readonly (readonly [bigint, VirtioRegisterKind])[] = [
  [0x000n, 'magic'],
  [0x004n, 'version'],
  [0x008n, 'deviceId'],
  [0x00cn, 'vendorId'],
  [0x010n, 'deviceFeatures'],
  [0x014n, 'deviceFeaturesSel'],
  [0x020n, 'driverFeatures'],
  [0x024n, 'driverFeaturesSel'],
  [0x030n, 'queueSel'],
  [0x034n, 'queueNumMax'],
  [0x038n, 'queueNum'],
  [0x044n, 'queueReady'],
  [0x050n, 'queueNotify'],
  [0x060n, 'interruptStatus'],
  [0x064n, 'interruptAck'],
  [0x070n, 'status'],
  [0x080n, 'queueDescLow'],
  [0x084n, 'queueDescHigh'],
  [0x090n, 'queueDriverLow'],
  [0x094n, 'queueDriverHigh'],
  [0x0a0n, 'queueDeviceLow'],
  [0x0a4n, 'queueDeviceHigh'],
  [0x0fcn, 'configGeneration'],
];

const HOLES: readonly bigint[] = [
  0x018n,
  0x01cn,
  0x028n,
  0x03cn,
  0x048n,
  0x054n,
  0x068n,
  0x074n,
  0x088n,
  0x098n,
  0x0a8n,
  0x0f8n,
  0x108n,
  0x1004n,
];

describe('virtio layout', () => {
  it('virtioOffsetToLocation decodes every live register and rejects holes', () => {
    for (const [offset, kind] of LIVE_REGISTERS) {
      assert.deepEqual(virtioOffsetToLocation(offset), { kind, byteOffset: 0 });
    }
    // The capacity is an 8-byte span, not a single u32.
    for (let byteOffset = 0; byteOffset < 8; byteOffset += 1) {
      assert.deepEqual(virtioOffsetToLocation(0x100n + BigInt(byteOffset)), {
        kind: 'configCapacity',
        byteOffset,
      });
    }
    // Byte offsets 1–3 within any register word.
    for (let byteOffset = 1; byteOffset < 4; byteOffset += 1) {
      assert.deepEqual(virtioOffsetToLocation(BigInt(byteOffset)), { kind: 'magic', byteOffset });
    }
    for (const hole of HOLES) {
      assert.equal(virtioOffsetToLocation(hole), null);
    }
    assert.equal(virtioOffsetToLocation(0x1000n), null);
    assert.equal(virtioOffsetToLocation(-1n), null);
  });

  it('initializeVirtio zeroes the whole slab and sets the present flag', () => {
    const memory = createTestMemory(64n);
    const region = memory.regions.get(VIRTIO_REGION_ID);
    assert.ok(region);
    const base = bigIntAsNumber(region.hostIndex);
    const length = Number(VIRTIO_HOST_BYTE_LENGTH);
    memory.bytes.fill(0xff, base, base + length);

    initializeVirtio(memory, true);
    for (let index = 0; index < length; index += 1) {
      assert.equal(memory.bytes[base + index], index === VIRTIO_HOST_DEVICE_PRESENT ? 1 : 0);
    }

    memory.bytes.fill(0xaa, base, base + length);
    initializeVirtio(memory, false);
    assert.equal(loadVirtioShadowU32(memory, VIRTIO_HOST_DEVICE_PRESENT), 0);
    assert.equal(memory.bytes[base + VIRTIO_HOST_DEVICE_PRESENT + 1], 0);
  });
});
