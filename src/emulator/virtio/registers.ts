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

/** Virtio register shadows, guest register semantics, and post-store side effects. */

import type { ReadonlyUint8Array } from '#types';
import type { Memory } from '#emulator/memory';
import { PLIC_SOURCE_VIRTIO, setPlicSourcePending } from '#emulator/plic';
import { publishWakeLevel } from '#emulator/wake';
import type { VirtioRegisterKind } from '#emulator/virtio/layout';
import {
  VIRTIO_BLK_SECTOR_BYTES,
  VIRTIO_CONFIG_S_ACKNOWLEDGE,
  VIRTIO_CONFIG_S_FEATURES_OK,
  VIRTIO_DEVICE_FEATURES_HI,
  VIRTIO_DEVICE_FEATURES_LO,
  VIRTIO_DEVICE_ID_BLOCK,
  VIRTIO_HOST_CONFIG_GENERATION,
  VIRTIO_HOST_DEVICE_FEATURES_SEL,
  VIRTIO_HOST_DEVICE_PRESENT,
  VIRTIO_HOST_DISK_CAPACITY_HIGH,
  VIRTIO_HOST_DISK_CAPACITY_LOW,
  VIRTIO_HOST_DISK_CAPACITY_READY,
  VIRTIO_HOST_DRIVER_FEATURES_HI,
  VIRTIO_HOST_DRIVER_FEATURES_LO,
  VIRTIO_HOST_DRIVER_FEATURES_SEL,
  VIRTIO_HOST_INTERRUPT_STATUS,
  VIRTIO_HOST_QUEUE_DESC_HIGH,
  VIRTIO_HOST_QUEUE_DESC_LOW,
  VIRTIO_HOST_QUEUE_DEVICE_HIGH,
  VIRTIO_HOST_QUEUE_DEVICE_LOW,
  VIRTIO_HOST_QUEUE_DRIVER_HIGH,
  VIRTIO_HOST_QUEUE_DRIVER_LOW,
  VIRTIO_HOST_QUEUE_NOTIFY,
  VIRTIO_HOST_QUEUE_NOTIFIED,
  VIRTIO_HOST_QUEUE_NUM,
  VIRTIO_HOST_QUEUE_READY,
  VIRTIO_HOST_QUEUE_SEL,
  VIRTIO_HOST_STATUS,
  VIRTIO_MAGIC_VALUE,
  VIRTIO_MMIO_INT_VRING,
  VIRTIO_MMIO_INTERRUPT_ACK,
  VIRTIO_MMIO_QUEUE_NOTIFY,
  VIRTIO_MMIO_STATUS,
  VIRTIO_QUEUE_NUM_MAX,
  VIRTIO_VENDOR_ID,
  VIRTIO_VERSION,
  isValidVirtioQueueNum,
  virtioHostInt32,
  virtioHostIndex,
  VIRTIO_HOST_WAKE_SEQ,
  VIRTIO_HOST_QUEUE_EPOCH,
  virtioOffsetToLocation,
} from '#emulator/virtio/layout';
import { byteOfU32, byteOfU64 } from '#utils/bytes';
import { rangesOverlap } from '#utils/ranges';

/** Device-present flag (host-owned, read by the CPU worker) via Atomics, giving the
 *  release/acquire ordering a guest needs: seeing present == 1 must also reveal the disk
 *  worker's capacity / config-generation writes that preceded the flip (§FIX 1). */
const loadVirtioDevicePresent = (memory: Memory): number =>
  Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_DEVICE_PRESENT), 0) >>> 0;

const storeVirtioDevicePresent = (memory: Memory, present: boolean): void => {
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_DEVICE_PRESENT), 0, present ? 1 : 0);
};

const loadVirtioShadowU32 = (memory: Memory, hostOffset: number): number => {
  const base = virtioHostIndex(memory, hostOffset);
  return (
    ((memory.bytes[base] ?? 0) |
      ((memory.bytes[base + 1] ?? 0) << 8) |
      ((memory.bytes[base + 2] ?? 0) << 16) |
      ((memory.bytes[base + 3] ?? 0) << 24)) >>>
    0
  );
};

const storeVirtioShadowU32 = (memory: Memory, hostOffset: number, value: number): void => {
  const base = virtioHostIndex(memory, hostOffset);
  const word = value >>> 0;
  memory.bytes[base] = word & 0xff;
  memory.bytes[base + 1] = (word >>> 8) & 0xff;
  memory.bytes[base + 2] = (word >>> 16) & 0xff;
  memory.bytes[base + 3] = (word >>> 24) & 0xff;
};

const loadVirtioShadowByte = (memory: Memory, hostOffset: number, byteOffset: number): number =>
  memory.bytes[virtioHostIndex(memory, hostOffset) + byteOffset] ?? 0;

const storeVirtioShadowByte = (
  memory: Memory,
  hostOffset: number,
  byteOffset: number,
  value: number
): void => {
  memory.bytes[virtioHostIndex(memory, hostOffset) + byteOffset] = value & 0xff;
};

/** Capacity shadows are immutable after startup, including after readiness withdrawal.
 * An in-progress reader may finish with the intact old value; later readers get zero.
 * This READY load is the acquire half of the release/acquire publication in device.ts:
 * observing READY = 1 makes the plain capacity/generation stores visible, so one snapshot
 * per guest access stays consistent without atomic payload words. */
const loadVirtioDiskCapacity = (memory: Memory): bigint => {
  if (Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_DISK_CAPACITY_READY), 0) === 0) {
    return 0n;
  }
  const low = loadVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_LOW);
  const high = loadVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH);
  return (BigInt(high) << 32n) | BigInt(low);
};

/** Read one byte of a guest access whose presence and capacity were already snapshotted. */
const loadVirtioRegisterByte = (memory: Memory, offset: bigint, capacity: bigint): number => {
  const location = virtioOffsetToLocation(offset);
  if (location === null) {
    return 0;
  }
  const { kind, byteOffset } = location;
  const queueSel = loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_SEL);
  switch (kind) {
    case 'magic':
      return byteOfU32(VIRTIO_MAGIC_VALUE, byteOffset);
    case 'version':
      return byteOfU32(VIRTIO_VERSION, byteOffset);
    case 'deviceId':
      return byteOfU32(VIRTIO_DEVICE_ID_BLOCK, byteOffset);
    case 'vendorId':
      return byteOfU32(VIRTIO_VENDOR_ID, byteOffset);
    case 'deviceFeatures': {
      const sel = loadVirtioShadowU32(memory, VIRTIO_HOST_DEVICE_FEATURES_SEL);
      const word =
        sel === 0 ? VIRTIO_DEVICE_FEATURES_LO : sel === 1 ? VIRTIO_DEVICE_FEATURES_HI : 0;
      return byteOfU32(word, byteOffset);
    }
    case 'queueNumMax':
      return queueSel === 0 ? byteOfU32(VIRTIO_QUEUE_NUM_MAX, byteOffset) : 0;
    case 'queueNum':
      return queueSel === 0 ? loadVirtioShadowByte(memory, VIRTIO_HOST_QUEUE_NUM, byteOffset) : 0;
    case 'queueReady':
      return queueSel === 0 ? loadVirtioShadowByte(memory, VIRTIO_HOST_QUEUE_READY, byteOffset) : 0;
    case 'interruptStatus':
      return loadVirtioShadowByte(memory, VIRTIO_HOST_INTERRUPT_STATUS, byteOffset);
    case 'status':
      return loadVirtioShadowByte(memory, VIRTIO_HOST_STATUS, byteOffset);
    case 'configGeneration':
      return byteOfU32(loadVirtioShadowU32(memory, VIRTIO_HOST_CONFIG_GENERATION), byteOffset);
    case 'configCapacity':
      return byteOfU64(capacity / BigInt(VIRTIO_BLK_SECTOR_BYTES), byteOffset);
    default:
      // W-only registers and every other read-as-zero register.
      return 0;
  }
};

/** Guest register load with presence and capacity snapshotted once per access. */
const loadVirtioRegisterBytes = (
  memory: Memory,
  offset: bigint,
  destination: Uint8Array,
  byteLength: number
): void => {
  // Presence/readiness can withdraw concurrently with shutdown. Snapshot once per guest
  // access, not per byte, so a scalar capacity read yields the intact old value or zero.
  const present = loadVirtioDevicePresent(memory) !== 0;
  const capacity = present ? loadVirtioDiskCapacity(memory) : 0n;
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    destination[byteIndex] = present
      ? loadVirtioRegisterByte(memory, offset + BigInt(byteIndex), capacity)
      : 0;
  }
};

/** Host offset of one of the six queue-address registers. */
const queueAddressHostOffset = (kind: VirtioRegisterKind): number | undefined => {
  switch (kind) {
    case 'queueDescLow':
      return VIRTIO_HOST_QUEUE_DESC_LOW;
    case 'queueDescHigh':
      return VIRTIO_HOST_QUEUE_DESC_HIGH;
    case 'queueDriverLow':
      return VIRTIO_HOST_QUEUE_DRIVER_LOW;
    case 'queueDriverHigh':
      return VIRTIO_HOST_QUEUE_DRIVER_HIGH;
    case 'queueDeviceLow':
      return VIRTIO_HOST_QUEUE_DEVICE_LOW;
    case 'queueDeviceHigh':
      return VIRTIO_HOST_QUEUE_DEVICE_HIGH;
    default:
      return undefined;
  }
};

const queueConfigurationWritable = (memory: Memory, queueSel: number): boolean =>
  queueSel === 0 && loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_READY) === 0;

/** Per-byte write action; read-only registers are ignored. */
const storeVirtioRegisterByte = (memory: Memory, offset: bigint, value: number): void => {
  if (loadVirtioDevicePresent(memory) === 0) {
    return;
  }
  const location = virtioOffsetToLocation(offset);
  if (location === null) {
    return;
  }
  const { kind, byteOffset } = location;
  const byte = value & 0xff;
  const queueSel = loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_SEL);
  switch (kind) {
    case 'deviceFeaturesSel':
      storeVirtioShadowByte(memory, VIRTIO_HOST_DEVICE_FEATURES_SEL, byteOffset, byte);
      return;
    case 'driverFeatures': {
      const sel = loadVirtioShadowU32(memory, VIRTIO_HOST_DRIVER_FEATURES_SEL);
      if (sel === 0) {
        storeVirtioShadowByte(memory, VIRTIO_HOST_DRIVER_FEATURES_LO, byteOffset, byte);
      } else if (sel === 1) {
        storeVirtioShadowByte(memory, VIRTIO_HOST_DRIVER_FEATURES_HI, byteOffset, byte);
      }
      return;
    }
    case 'driverFeaturesSel':
      storeVirtioShadowByte(memory, VIRTIO_HOST_DRIVER_FEATURES_SEL, byteOffset, byte);
      return;
    case 'queueSel':
      storeVirtioShadowByte(memory, VIRTIO_HOST_QUEUE_SEL, byteOffset, byte);
      return;
    case 'queueNum': {
      if (!queueConfigurationWritable(memory, queueSel)) {
        return;
      }
      // WARL: only power-of-two sizes (0/1/2/4/8) are accepted.
      const current = loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_NUM);
      const candidate =
        ((current & ~(0xff << (byteOffset * 8))) | (byte << (byteOffset * 8))) >>> 0;
      if (isValidVirtioQueueNum(candidate)) {
        storeVirtioShadowByte(memory, VIRTIO_HOST_QUEUE_NUM, byteOffset, byte);
      }
      return;
    }
    case 'queueReady':
      if (queueSel === 0) {
        storeVirtioShadowByte(memory, VIRTIO_HOST_QUEUE_READY, byteOffset, byte);
      }
      return;
    case 'queueDescLow':
    case 'queueDescHigh':
    case 'queueDriverLow':
    case 'queueDriverHigh':
    case 'queueDeviceLow':
    case 'queueDeviceHigh': {
      const hostOffset = queueAddressHostOffset(kind);
      if (queueConfigurationWritable(memory, queueSel) && hostOffset !== undefined) {
        storeVirtioShadowByte(memory, hostOffset, byteOffset, byte);
      }
      return;
    }
    case 'queueNotify':
      // W-only shadow: bytes accumulate here; the wake side effect fires once the whole
      // access is written (full-word compare in handleQueueNotify, §FIX 2).
      storeVirtioShadowByte(memory, VIRTIO_HOST_QUEUE_NOTIFY, byteOffset, byte);
      return;
    case 'status':
      storeVirtioShadowByte(memory, VIRTIO_HOST_STATUS, byteOffset, byte);
      return;
    default:
      // Read-only registers, plus queueNotify/interruptAck whose side effects fire
      // once the whole access has been written (see storeVirtioRegisterBytes).
      return;
  }
};

const wakeVirtioQueue = (memory: Memory): void => {
  const word = virtioHostInt32(memory, VIRTIO_HOST_WAKE_SEQ);
  publishWakeLevel({
    bytes: memory.bytes,
    index: virtioHostIndex(memory, VIRTIO_HOST_WAKE_SEQ),
    level: (Atomics.load(word, 0) + 1) >>> 0,
  });
};
const invalidateVirtioQueue = (memory: Memory): void => {
  storeVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_NOTIFIED, 0);
  storeVirtioShadowU32(
    memory,
    VIRTIO_HOST_QUEUE_EPOCH,
    loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_EPOCH) + 1
  );
  wakeVirtioQueue(memory);
};

/** Reset shadows and revoke every old queue claim before returning guest ownership. */
const resetVirtioDevice = (memory: Memory): void => {
  const clearedHostOffsets = [
    VIRTIO_HOST_DEVICE_FEATURES_SEL,
    VIRTIO_HOST_DRIVER_FEATURES_LO,
    VIRTIO_HOST_DRIVER_FEATURES_HI,
    VIRTIO_HOST_DRIVER_FEATURES_SEL,
    VIRTIO_HOST_QUEUE_SEL,
    VIRTIO_HOST_QUEUE_NUM,
    VIRTIO_HOST_QUEUE_READY,
    VIRTIO_HOST_QUEUE_NOTIFY,
    VIRTIO_HOST_QUEUE_NOTIFIED,
    VIRTIO_HOST_QUEUE_DESC_LOW,
    VIRTIO_HOST_QUEUE_DESC_HIGH,
    VIRTIO_HOST_QUEUE_DRIVER_LOW,
    VIRTIO_HOST_QUEUE_DRIVER_HIGH,
    VIRTIO_HOST_QUEUE_DEVICE_LOW,
    VIRTIO_HOST_QUEUE_DEVICE_HIGH,
    VIRTIO_HOST_INTERRUPT_STATUS,
  ];
  for (const hostOffset of clearedHostOffsets) {
    storeVirtioShadowU32(memory, hostOffset, 0);
  }
  invalidateVirtioQueue(memory);
  setPlicSourcePending(memory, PLIC_SOURCE_VIRTIO, false);
};

/** QueueNotify wake: an assembled zero word signals the worker, never performs DMA. */
const handleQueueNotify = (
  memory: Memory,
  offset: bigint,
  byteLength: number,
  _source: ReadonlyUint8Array
): void => {
  if (!rangesOverlap(offset, BigInt(byteLength), VIRTIO_MMIO_QUEUE_NOTIFY, 4n)) {
    return;
  }
  // §FIX 2: assemble the FULL 32-bit word from the store (the per-byte writes above have
  // already landed in the queueNotify shadow, so a partial store that is later completed
  // yields the correct assembled value). Only an assembled value of exactly 0 addresses an
  // existing queue (queue 0) and wakes it; any non-zero value names no queue and is
  // ignored entirely — real device behavior, NOT a trap.
  if (loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_NOTIFY) === 0) {
    storeVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_NOTIFIED, 1);
    wakeVirtioQueue(memory);
  }
};

/** InterruptACK: bit 0 clears the interrupt and deasserts PLIC source 1. */
const handleInterruptAck = (
  memory: Memory,
  offset: bigint,
  byteLength: number,
  source: ReadonlyUint8Array
): void => {
  if (!rangesOverlap(offset, BigInt(byteLength), VIRTIO_MMIO_INTERRUPT_ACK, 4n)) {
    return;
  }
  let ackBits = 0;
  for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
    const registerAddress = VIRTIO_MMIO_INTERRUPT_ACK + BigInt(byteIndex);
    if (registerAddress >= offset && registerAddress < offset + BigInt(byteLength)) {
      ackBits |= (source[Number(registerAddress - offset)] ?? 0) << (byteIndex * 8);
    }
  }
  if ((ackBits & VIRTIO_MMIO_INT_VRING) !== 0) {
    const word = loadVirtioShadowU32(memory, VIRTIO_HOST_INTERRUPT_STATUS) & ~VIRTIO_MMIO_INT_VRING;
    storeVirtioShadowU32(memory, VIRTIO_HOST_INTERRUPT_STATUS, word >>> 0);
    setPlicSourcePending(memory, PLIC_SOURCE_VIRTIO, false);
  }
};

/**
 * §3.1.1 FEATURES_OK validation: true when the driver accepted no unadvertised feature
 * bit. The device advertises VIRTIO_F_VERSION_1 only (LO word empty, HI word bit 0), so any
 * other bit is unadvertised. §FIX 4 follows QEMU's leniency and does NOT require the driver
 * to accept VERSION_1: xv6 negotiates driver features 0 and must still reach DRIVER_OK;
 * strict VERSION_1 enforcement would clear FEATURES_OK and panic xv6's probe.
 */
const driverFeaturesAreValid = (memory: Memory): boolean => {
  const lo = loadVirtioShadowU32(memory, VIRTIO_HOST_DRIVER_FEATURES_LO);
  const hi = loadVirtioShadowU32(memory, VIRTIO_HOST_DRIVER_FEATURES_HI);
  return (lo & ~VIRTIO_DEVICE_FEATURES_LO) === 0 && (hi & ~VIRTIO_DEVICE_FEATURES_HI) === 0;
};

/** Status: a stored word with ACKNOWLEDGE clear resets the device; FEATURES_OK is validated. */
const handleStatusWrite = (memory: Memory, offset: bigint, byteLength: number): void => {
  if (!rangesOverlap(offset, BigInt(byteLength), VIRTIO_MMIO_STATUS, 4n)) {
    return;
  }
  const status = loadVirtioShadowU32(memory, VIRTIO_HOST_STATUS);
  // §FIX 4: if this write set FEATURES_OK but the driver accepted an unadvertised feature
  // bit, silently clear the bit (the driver re-reads status and sees failure — no trap).
  if ((status & VIRTIO_CONFIG_S_FEATURES_OK) !== 0 && !driverFeaturesAreValid(memory)) {
    storeVirtioShadowU32(memory, VIRTIO_HOST_STATUS, status & ~VIRTIO_CONFIG_S_FEATURES_OK);
  }
  if ((status & VIRTIO_CONFIG_S_ACKNOWLEDGE) === 0) {
    resetVirtioDevice(memory);
  }
};

/** Guest register store and side effects; caller holds the reservation and PLIC gateway locks. */
const storeVirtioRegisterBytes = (
  memory: Memory,
  offset: bigint,
  source: ReadonlyUint8Array,
  byteLength: number
): void => {
  if (loadVirtioDevicePresent(memory) === 0) {
    return;
  }
  const ready = loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_READY);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    storeVirtioRegisterByte(memory, offset + BigInt(byteIndex), source[byteIndex] ?? 0);
  }
  // Side effects run after the byte loop so a register word is fully assembled first:
  // firing the wake or the reset mid-word would act on a half-written value.
  if (ready !== 0 && loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_READY) === 0)
    invalidateVirtioQueue(memory);
  handleQueueNotify(memory, offset, byteLength, source);
  handleInterruptAck(memory, offset, byteLength, source);
  handleStatusWrite(memory, offset, byteLength);
};

export {
  loadVirtioDevicePresent,
  loadVirtioDiskCapacity,
  loadVirtioShadowU32,
  storeVirtioDevicePresent,
  storeVirtioShadowU32,
  loadVirtioRegisterBytes,
  storeVirtioRegisterBytes,
};
