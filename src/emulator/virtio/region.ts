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
 * VirtIO-MMIO region layout — dense guest register prefix plus a host-only
 * notification word.
 */

import type { Memory } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';
import { bytesToBigInt, unsignedBigIntToBytes, unsignedNumberToBytes } from '#utils/bytes';
import { bigIntAsNumber } from '#utils/int';

/** Packed-region id for the VirtIO block device. */
const VIRTIO_REGION_ID = 'virtio';

/** Guest-visible VirtIO-MMIO window. */
const VIRTIO_GUEST_BYTE_LENGTH = 0x1000n;

/** Host slab: the guest-visible prefix, a notification Int32, and four pad bytes. */
const VIRTIO_HOST_BYTE_LENGTH = 0x1008n;

/** Host-only notification word at the end of the VirtIO slab. */
const VIRTIO_HOST_OFFSET = {
  kick: 0x1000,
} as const;

/** Guest register offsets from the modern VirtIO-MMIO v2 register map. */
const VIRTIO_REGISTER_OFFSET = {
  magicValue: 0x000,
  version: 0x004,
  deviceId: 0x008,
  vendorId: 0x00c,
  deviceFeatures: 0x010,
  deviceFeaturesSel: 0x014,
  driverFeatures: 0x020,
  driverFeaturesSel: 0x024,
  queueSel: 0x030,
  queueNumMax: 0x034,
  queueNum: 0x038,
  queueReady: 0x044,
  queueNotify: 0x050,
  interruptStatus: 0x060,
  interruptAck: 0x064,
  status: 0x070,
  queueDescLow: 0x080,
  queueDescHigh: 0x084,
  queueDriverLow: 0x090,
  queueDriverHigh: 0x094,
  queueDeviceLow: 0x0a0,
  queueDeviceHigh: 0x0a4,
  configCapacity: 0x100,
  configSizeMax: 0x108,
  configSegMax: 0x10c,
  configBlockSize: 0x114,
} as const;

/** Internal state stored in guest-register holes and therefore never exposed. */
const VIRTIO_INTERNAL_OFFSET = {
  queueConfigured: 0x200,
  lastAvailIndex: 0x204,
  driverFeaturesLow: 0x208,
  driverFeaturesHigh: 0x20c,
} as const;

const virtioRegion = (memory: Memory) => {
  const region = memory.regions.get(VIRTIO_REGION_ID);
  if (region === undefined) {
    throw new Error(`Memory region '${VIRTIO_REGION_ID}' is not packed.`);
  }
  if (region.guestAddress === null) {
    throw new Error(`Memory region '${VIRTIO_REGION_ID}' is host-only; expected a guest window.`);
  }
  return region;
};

/** Absolute host byte index for an offset within the VirtIO slab. */
const virtioHostIndex = (memory: Memory, offset: number): number =>
  bigIntAsNumber(virtioRegion(memory).hostIndex + BigInt(offset));

/** Initialize register state and the block-device configuration space. */
const initializeVirtio = (memory: Memory, imageByteLength: number): void => {
  const region = virtioRegion(memory);
  const base = bigIntAsNumber(region.hostIndex);
  memory.bytes.fill(0, base, base + bigIntAsNumber(region.hostByteLength));

  const capacity = BigInt(Math.floor(imageByteLength / 512));
  const capacityBytes = unsignedBigIntToBytes(new Uint8Array(8), capacity);
  memory.bytes.set(capacityBytes, base + VIRTIO_REGISTER_OFFSET.configCapacity);
  memory.bytes.set(
    unsignedNumberToBytes(new Uint8Array(8), 0),
    base + VIRTIO_REGISTER_OFFSET.configSizeMax
  );
  memory.bytes.set(
    unsignedNumberToBytes(new Uint8Array(8), 8),
    base + VIRTIO_REGISTER_OFFSET.configSegMax
  );
  memory.bytes.set(
    unsignedNumberToBytes(new Uint8Array(8), 512),
    base + VIRTIO_REGISTER_OFFSET.configBlockSize
  );
};

/** Add a byte offset to an architectural guest address. */
const guestAddressPlus = (address: ReadonlyUint8Array, byteOffset: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), BigInt.asUintN(64, bytesToBigInt(address) + byteOffset));

export {
  VIRTIO_GUEST_BYTE_LENGTH,
  VIRTIO_HOST_BYTE_LENGTH,
  VIRTIO_HOST_OFFSET,
  VIRTIO_INTERNAL_OFFSET,
  VIRTIO_REGION_ID,
  VIRTIO_REGISTER_OFFSET,
  guestAddressPlus,
  initializeVirtio,
  virtioHostIndex,
  virtioRegion,
};
