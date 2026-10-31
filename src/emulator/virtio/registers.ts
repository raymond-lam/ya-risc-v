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
 * VirtIO-MMIO v2 register semantics for a single read-only block device.
 */

import type { Memory } from '#emulator/memory';
import { PLIC_SOURCE_VIRTIO, setPlicSourcePending } from '#emulator/plic';
import {
  VIRTIO_HOST_OFFSET,
  VIRTIO_INTERNAL_OFFSET,
  VIRTIO_REGISTER_OFFSET,
  virtioHostIndex,
} from '#emulator/virtio/region';
import { publishWakeLevel } from '#emulator/wake';
import type { ReadonlyUint8Array } from '#types';
import { bytesToInt32Array, bytesToNumber } from '#utils/bytes';

const MAGIC_VALUE = 0x7472_6976;
const VERSION = 2;
const DEVICE_ID_BLOCK = 2;
const VENDOR_ID = 0x554d_4551;
const QUEUE_NUM_MAX = 8;
const VIRTIO_F_VERSION_1 = 1;

const STATUS_FEATURES_OK = 8;

const QUEUE_CONFIGURED_DESC_LOW = 1;
const QUEUE_CONFIGURED_DESC_HIGH = 2;
const QUEUE_CONFIGURED_DRIVER_LOW = 4;
const QUEUE_CONFIGURED_DRIVER_HIGH = 8;
const QUEUE_CONFIGURED_DEVICE_LOW = 16;
const QUEUE_CONFIGURED_DEVICE_HIGH = 32;
const QUEUE_CONFIGURED_ALL =
  QUEUE_CONFIGURED_DESC_LOW |
  QUEUE_CONFIGURED_DESC_HIGH |
  QUEUE_CONFIGURED_DRIVER_LOW |
  QUEUE_CONFIGURED_DRIVER_HIGH |
  QUEUE_CONFIGURED_DEVICE_LOW |
  QUEUE_CONFIGURED_DEVICE_HIGH;

const loadHostUint32 = (memory: Memory, offset: number): number => {
  const base = virtioHostIndex(memory, offset);
  return (
    ((memory.bytes[base] ?? 0) |
      ((memory.bytes[base + 1] ?? 0) << 8) |
      ((memory.bytes[base + 2] ?? 0) << 16) |
      ((memory.bytes[base + 3] ?? 0) << 24)) >>>
    0
  );
};

const storeHostUint32 = (memory: Memory, offset: number, value: number): void => {
  const base = virtioHostIndex(memory, offset);
  const word = value >>> 0;
  memory.bytes[base] = word & 0xff;
  memory.bytes[base + 1] = (word >>> 8) & 0xff;
  memory.bytes[base + 2] = (word >>> 16) & 0xff;
  memory.bytes[base + 3] = (word >>> 24) & 0xff;
};

const advertisedFeatures = (selector: number): number => (selector === 1 ? VIRTIO_F_VERSION_1 : 0);

const setDriverFeatures = (memory: Memory, value: number): void => {
  const selector = loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.driverFeaturesSel);
  const offset =
    selector === 0
      ? VIRTIO_INTERNAL_OFFSET.driverFeaturesLow
      : selector === 1
        ? VIRTIO_INTERNAL_OFFSET.driverFeaturesHigh
        : VIRTIO_INTERNAL_OFFSET.driverFeaturesLow + 8;
  const accepted = (value >>> 0) & advertisedFeatures(selector);
  storeHostUint32(memory, offset, accepted);
  if (accepted !== value >>> 0) {
    const status = loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.status);
    storeHostUint32(memory, VIRTIO_REGISTER_OFFSET.status, status & ~STATUS_FEATURES_OK);
  }
};

const queueConfigurationBits = (memory: Memory): number =>
  loadHostUint32(memory, VIRTIO_INTERNAL_OFFSET.queueConfigured);

const markQueueConfigured = (memory: Memory, bit: number): void => {
  storeHostUint32(
    memory,
    VIRTIO_INTERNAL_OFFSET.queueConfigured,
    queueConfigurationBits(memory) | bit
  );
};

const queueIsReady = (memory: Memory): boolean =>
  loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.queueReady) !== 0;

const setQueueReady = (memory: Memory, ready: boolean): void => {
  const queueNum = loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.queueNum);
  const validQueueNum =
    queueNum > 0 && queueNum <= QUEUE_NUM_MAX && (queueNum & (queueNum - 1)) === 0;
  const configured =
    (queueConfigurationBits(memory) & QUEUE_CONFIGURED_ALL) === QUEUE_CONFIGURED_ALL;
  const value = ready && validQueueNum && configured ? 1 : 0;
  storeHostUint32(memory, VIRTIO_REGISTER_OFFSET.queueReady, value);
};

const queueIsSelected = (memory: Memory): boolean =>
  loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.queueSel) === 0;

const publishQueueNotify = (memory: Memory): void => {
  const kickIndex = virtioHostIndex(memory, VIRTIO_HOST_OFFSET.kick);
  const kick = bytesToInt32Array(memory.bytes, kickIndex);
  publishWakeLevel({
    bytes: memory.bytes,
    index: kickIndex,
    level: Atomics.load(kick, 0) + 1,
  });
};

const acknowledgeInterrupts = (memory: Memory, written: number): void => {
  const statusIndex = virtioHostIndex(memory, VIRTIO_REGISTER_OFFSET.interruptStatus);
  Atomics.and(memory.bytes, statusIndex, ~written);
  if ((Atomics.load(memory.bytes, statusIndex) & 1) === 0) {
    setPlicSourcePending(memory, PLIC_SOURCE_VIRTIO, false);
  }
};

/** Load one byte of a VirtIO register. Holes and write-only registers read zero. */
const loadVirtioRegisterByte = (memory: Memory, offset: number): number => {
  if (
    offset >= VIRTIO_REGISTER_OFFSET.configCapacity &&
    offset < VIRTIO_REGISTER_OFFSET.configCapacity + 8
  ) {
    const base = virtioHostIndex(memory, VIRTIO_REGISTER_OFFSET.configCapacity);
    return memory.bytes[base + (offset - VIRTIO_REGISTER_OFFSET.configCapacity)] ?? 0;
  }
  const registerOffset = offset & ~3;
  const byteIndex = offset & 3;
  switch (registerOffset) {
    case VIRTIO_REGISTER_OFFSET.magicValue:
      return (MAGIC_VALUE >>> (byteIndex * 8)) & 0xff;
    case VIRTIO_REGISTER_OFFSET.version:
      return (VERSION >>> (byteIndex * 8)) & 0xff;
    case VIRTIO_REGISTER_OFFSET.deviceId:
      return (DEVICE_ID_BLOCK >>> (byteIndex * 8)) & 0xff;
    case VIRTIO_REGISTER_OFFSET.vendorId:
      return (VENDOR_ID >>> (byteIndex * 8)) & 0xff;
    case VIRTIO_REGISTER_OFFSET.deviceFeatures: {
      const selector = loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.deviceFeaturesSel);
      return (advertisedFeatures(selector) >>> (byteIndex * 8)) & 0xff;
    }
    case VIRTIO_REGISTER_OFFSET.queueNumMax:
      return (QUEUE_NUM_MAX >>> (byteIndex * 8)) & 0xff;
    case VIRTIO_REGISTER_OFFSET.queueReady:
      return byteIndex === 0 && queueIsReady(memory) ? 1 : 0;
    case VIRTIO_REGISTER_OFFSET.interruptStatus:
      return byteIndex === 0
        ? Atomics.load(
            memory.bytes,
            virtioHostIndex(memory, VIRTIO_REGISTER_OFFSET.interruptStatus)
          ) & 1
        : 0;
    case VIRTIO_REGISTER_OFFSET.status:
      return byteIndex === 0 ? loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.status) & 0xff : 0;

    case VIRTIO_REGISTER_OFFSET.configSizeMax:
      return (
        (loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.configSizeMax) >>> (byteIndex * 8)) & 0xff
      );
    case VIRTIO_REGISTER_OFFSET.configSegMax:
      return (
        (loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.configSegMax) >>> (byteIndex * 8)) & 0xff
      );
    case VIRTIO_REGISTER_OFFSET.configBlockSize:
      return (
        (loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.configBlockSize) >>> (byteIndex * 8)) & 0xff
      );
    default:
      return 0;
  }
};

const storeQueueNum = (memory: Memory, value: number): void => {
  if (!queueIsSelected(memory)) {
    return;
  }
  const valid = value > 0 && value <= QUEUE_NUM_MAX && (value & (value - 1)) === 0;
  if (!valid) {
    return;
  }
  storeHostUint32(memory, VIRTIO_REGISTER_OFFSET.queueNum, value);
  setQueueReady(memory, false);
};

const storeQueueReady = (memory: Memory, ready: boolean): void => {
  if (!queueIsSelected(memory)) {
    return;
  }
  setQueueReady(memory, ready);
};

const queueAddressConfiguredBit = (offset: number): number => {
  switch (offset) {
    case VIRTIO_REGISTER_OFFSET.queueDescLow:
      return QUEUE_CONFIGURED_DESC_LOW;
    case VIRTIO_REGISTER_OFFSET.queueDescHigh:
      return QUEUE_CONFIGURED_DESC_HIGH;
    case VIRTIO_REGISTER_OFFSET.queueDriverLow:
      return QUEUE_CONFIGURED_DRIVER_LOW;
    case VIRTIO_REGISTER_OFFSET.queueDriverHigh:
      return QUEUE_CONFIGURED_DRIVER_HIGH;
    case VIRTIO_REGISTER_OFFSET.queueDeviceLow:
      return QUEUE_CONFIGURED_DEVICE_LOW;
    default:
      return QUEUE_CONFIGURED_DEVICE_HIGH;
  }
};

const storeQueueAddress = (memory: Memory, offset: number, value: number): void => {
  if (!queueIsSelected(memory)) {
    return;
  }
  storeHostUint32(memory, offset, value);
  markQueueConfigured(memory, queueAddressConfiguredBit(offset));
  setQueueReady(memory, false);
};

/** Store one aligned VirtIO register. */
const storeVirtioRegister = (memory: Memory, offset: number, source: ReadonlyUint8Array): void => {
  const value = bytesToNumber(source);
  switch (offset) {
    case VIRTIO_REGISTER_OFFSET.deviceFeaturesSel:
      storeHostUint32(memory, VIRTIO_REGISTER_OFFSET.deviceFeaturesSel, value);
      return;
    case VIRTIO_REGISTER_OFFSET.driverFeatures:
      setDriverFeatures(memory, value);
      return;
    case VIRTIO_REGISTER_OFFSET.driverFeaturesSel:
      storeHostUint32(memory, VIRTIO_REGISTER_OFFSET.driverFeaturesSel, value);
      return;
    case VIRTIO_REGISTER_OFFSET.queueSel:
      storeHostUint32(memory, VIRTIO_REGISTER_OFFSET.queueSel, value);
      return;
    case VIRTIO_REGISTER_OFFSET.queueNum:
      storeQueueNum(memory, value);
      return;
    case VIRTIO_REGISTER_OFFSET.queueReady:
      storeQueueReady(memory, (source[0] ?? 0) !== 0);
      return;
    case VIRTIO_REGISTER_OFFSET.queueNotify:
      publishQueueNotify(memory);
      return;
    case VIRTIO_REGISTER_OFFSET.interruptAck:
      acknowledgeInterrupts(memory, source[0] ?? 0);
      return;
    case VIRTIO_REGISTER_OFFSET.status:
      storeHostUint32(memory, VIRTIO_REGISTER_OFFSET.status, source[0] ?? 0);
      return;
    case VIRTIO_REGISTER_OFFSET.queueDescLow:
    case VIRTIO_REGISTER_OFFSET.queueDescHigh:
    case VIRTIO_REGISTER_OFFSET.queueDriverLow:
    case VIRTIO_REGISTER_OFFSET.queueDriverHigh:
    case VIRTIO_REGISTER_OFFSET.queueDeviceLow:
    case VIRTIO_REGISTER_OFFSET.queueDeviceHigh:
      storeQueueAddress(memory, offset, value);
      return;
    default:
      return;
  }
};

export { loadVirtioRegisterByte, storeVirtioRegister };
