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

/** Virtio guest-window geometry, host-slab offsets, register decode, and views. */

import type { Memory } from '#emulator/memory';
import { bytesToInt32Array } from '#utils/bytes';
import { bigIntAsNumber } from '#utils/int';

/** Packed-region id for the virtio-mmio block device (`createMemory` / `regions.get`). */
const VIRTIO_REGION_ID = 'virtio';
/** Guest-visible MMIO window (sparse; holes read 0 / ignore stores). Always packed — even
 *  diskless, so a probe reads 0x00000000 instead of taking a load access fault. */
const VIRTIO_GUEST_BYTE_LENGTH = 0x1000n;
/** Maximum split-virtqueue depth this device supports (xv6's NUM). */
const VIRTIO_QUEUE_NUM_MAX = 8;
/** Maximum single-request data length, bounding a worker-local transfer buffer. */
const VIRTIO_MAX_TRANSFER_BYTES = 4096;
/** Upper bound on descriptor-chain hops while walking NEXT (cycle guard). */
const VIRTIO_MAX_CHAIN_DESCRIPTORS = 256;
const VIRTIO_HOST_BYTE_LENGTH = 96n;

const VIRTIO_MMIO_MAGIC = 0x000n; // MagicValue (RO)
const VIRTIO_MMIO_VERSION = 0x004n; // Version (RO)
const VIRTIO_MMIO_DEVICE_ID = 0x008n; // DeviceID (RO)
const VIRTIO_MMIO_VENDOR_ID = 0x00cn; // VendorID (RO)
const VIRTIO_MMIO_DEVICE_FEATURES = 0x010n; // DeviceFeatures (RO, selector)
const VIRTIO_MMIO_DEVICE_FEATURES_SEL = 0x014n; // DeviceFeaturesSel (WO)
const VIRTIO_MMIO_DRIVER_FEATURES = 0x020n; // DriverFeatures (WO)
const VIRTIO_MMIO_DRIVER_FEATURES_SEL = 0x024n; // DriverFeaturesSel (WO)
const VIRTIO_MMIO_QUEUE_SEL = 0x030n; // QueueSel (WO)
const VIRTIO_MMIO_QUEUE_NUM_MAX = 0x034n; // QueueNumMax (RO)
const VIRTIO_MMIO_QUEUE_NUM = 0x038n; // QueueNum (RW, WARL)
const VIRTIO_MMIO_QUEUE_READY = 0x044n; // QueueReady (RW)
const VIRTIO_MMIO_QUEUE_NOTIFY = 0x050n; // QueueNotify (WO, side effect)
const VIRTIO_MMIO_INTERRUPT_STATUS = 0x060n; // InterruptStatus (RO)
const VIRTIO_MMIO_INTERRUPT_ACK = 0x064n; // InterruptACK (WO, side effect)
const VIRTIO_MMIO_STATUS = 0x070n; // Status (RW, reset side effect)
const VIRTIO_MMIO_QUEUE_DESC_LOW = 0x080n; // QueueDescLow (WO)
const VIRTIO_MMIO_QUEUE_DESC_HIGH = 0x084n; // QueueDescHigh (WO)
const VIRTIO_MMIO_QUEUE_DRIVER_LOW = 0x090n; // QueueDriverLow (WO)
const VIRTIO_MMIO_QUEUE_DRIVER_HIGH = 0x094n; // QueueDriverHigh (WO)
const VIRTIO_MMIO_QUEUE_DEVICE_LOW = 0x0a0n; // QueueDeviceLow (WO)
const VIRTIO_MMIO_QUEUE_DEVICE_HIGH = 0x0a4n; // QueueDeviceHigh (WO)
const VIRTIO_MMIO_CONFIG_GENERATION = 0x0fcn; // ConfigGeneration (RO)
const VIRTIO_MMIO_CONFIG_CAPACITY = 0x100n; // blk capacity, u64 LE (RO, 8 bytes)

/** 'virt' little-endian. */
const VIRTIO_MAGIC_VALUE = 0x7472_6976;
/** Modern virtio-mmio transport (2). */
const VIRTIO_VERSION = 2;
/** virtio-blk device id. */
const VIRTIO_DEVICE_ID_BLOCK = 2;
/** 'QEMU' little-endian (matches what xv6 probes). */
const VIRTIO_VENDOR_ID = 0x554d_4551;

/** Low DeviceFeatures word: nothing advertised. */
const VIRTIO_DEVICE_FEATURES_LO = 0x0000_0000;
/** High DeviceFeatures word: VIRTIO_F_VERSION_1 only. */
const VIRTIO_DEVICE_FEATURES_HI = 0x0000_0001;

const VIRTIO_CONFIG_S_ACKNOWLEDGE = 0x01;
const VIRTIO_CONFIG_S_DRIVER = 0x02;
const VIRTIO_CONFIG_S_DRIVER_OK = 0x04;
const VIRTIO_CONFIG_S_FEATURES_OK = 0x08;

/** InterruptStatus bit 0: used-buffer (vring) notification. */
const VIRTIO_MMIO_INT_VRING = 0x1;

const VRING_DESC_F_NEXT = 0x1;
const VRING_DESC_F_WRITE = 0x2;
const VRING_DESC_F_INDIRECT = 0x4;

/** virtio-blk request header: { type u32, reserved u32, sector u64 }, LE. */
const VIRTIO_BLK_HEADER_BYTES = 16;
/** virtio-blk sector size (config capacity is in 512-byte sectors). */
const VIRTIO_BLK_SECTOR_BYTES = 512;
const VIRTIO_BLK_T_IN = 0;
const VIRTIO_BLK_T_OUT = 1;
const VIRTIO_BLK_S_OK = 0;
const VIRTIO_BLK_S_IOERR = 1;
const VIRTIO_BLK_S_UNSUPP = 2;

const VIRTIO_HOST_DEVICE_FEATURES_SEL = 0;
const VIRTIO_HOST_DRIVER_FEATURES_LO = 4;
const VIRTIO_HOST_DRIVER_FEATURES_HI = 8;
const VIRTIO_HOST_DRIVER_FEATURES_SEL = 12;
const VIRTIO_HOST_QUEUE_SEL = 16;
const VIRTIO_HOST_QUEUE_NUM = 20;
const VIRTIO_HOST_QUEUE_READY = 24;
const VIRTIO_HOST_STATUS = 28;
const VIRTIO_HOST_QUEUE_DESC_LOW = 32;
const VIRTIO_HOST_QUEUE_DESC_HIGH = 36;
const VIRTIO_HOST_QUEUE_DRIVER_LOW = 40;
const VIRTIO_HOST_QUEUE_DRIVER_HIGH = 44;
const VIRTIO_HOST_QUEUE_DEVICE_LOW = 48;
const VIRTIO_HOST_QUEUE_DEVICE_HIGH = 52;
const VIRTIO_HOST_INTERRUPT_STATUS = 56;
const VIRTIO_HOST_WAKE_SEQ = 60;
const VIRTIO_HOST_QUEUE_EPOCH = 64;
const VIRTIO_HOST_DEVICE_PRESENT = 68;
const VIRTIO_HOST_DISK_CAPACITY_LOW = 72;
const VIRTIO_HOST_DISK_CAPACITY_HIGH = 76;
const VIRTIO_HOST_DISK_CAPACITY_READY = 80;
const VIRTIO_HOST_CONFIG_GENERATION = 84;
const VIRTIO_HOST_QUEUE_NOTIFY = 88;
const VIRTIO_HOST_QUEUE_NOTIFIED = 92;

type VirtioRegisterKind =
  | 'magic'
  | 'version'
  | 'deviceId'
  | 'vendorId'
  | 'deviceFeatures'
  | 'deviceFeaturesSel'
  | 'driverFeatures'
  | 'driverFeaturesSel'
  | 'queueSel'
  | 'queueNumMax'
  | 'queueNum'
  | 'queueReady'
  | 'queueNotify'
  | 'interruptStatus'
  | 'interruptAck'
  | 'status'
  | 'queueDescLow'
  | 'queueDescHigh'
  | 'queueDriverLow'
  | 'queueDriverHigh'
  | 'queueDeviceLow'
  | 'queueDeviceHigh'
  | 'configGeneration'
  | 'configCapacity';

/** Decoded guest-window location: register identity + byte within it. */
type VirtioRegisterLocation = { kind: VirtioRegisterKind; byteOffset: number };

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

const virtioHostIndex = (memory: Memory, offset: number): number =>
  bigIntAsNumber(virtioRegion(memory).hostIndex + BigInt(offset));

const virtioHostInt32 = (memory: Memory, hostOffset: number): Int32Array =>
  bytesToInt32Array(memory.bytes, virtioHostIndex(memory, hostOffset));

/** Decode a guest offset within the virtio window (holes → `null`). */
const virtioOffsetToLocation = (offset: bigint): VirtioRegisterLocation | null => {
  if (offset < 0n || offset >= VIRTIO_GUEST_BYTE_LENGTH) {
    return null;
  }
  if (offset >= VIRTIO_MMIO_CONFIG_CAPACITY && offset < VIRTIO_MMIO_CONFIG_CAPACITY + 8n) {
    return { kind: 'configCapacity', byteOffset: Number(offset - VIRTIO_MMIO_CONFIG_CAPACITY) };
  }
  const registerOffset = offset & ~3n;
  const byteOffset = Number(offset & 3n);
  switch (registerOffset) {
    case 0x000n:
      return { kind: 'magic', byteOffset };
    case 0x004n:
      return { kind: 'version', byteOffset };
    case 0x008n:
      return { kind: 'deviceId', byteOffset };
    case 0x00cn:
      return { kind: 'vendorId', byteOffset };
    case 0x010n:
      return { kind: 'deviceFeatures', byteOffset };
    case 0x014n:
      return { kind: 'deviceFeaturesSel', byteOffset };
    case 0x020n:
      return { kind: 'driverFeatures', byteOffset };
    case 0x024n:
      return { kind: 'driverFeaturesSel', byteOffset };
    case 0x030n:
      return { kind: 'queueSel', byteOffset };
    case 0x034n:
      return { kind: 'queueNumMax', byteOffset };
    case 0x038n:
      return { kind: 'queueNum', byteOffset };
    case 0x044n:
      return { kind: 'queueReady', byteOffset };
    case 0x050n:
      return { kind: 'queueNotify', byteOffset };
    case 0x060n:
      return { kind: 'interruptStatus', byteOffset };
    case 0x064n:
      return { kind: 'interruptAck', byteOffset };
    case 0x070n:
      return { kind: 'status', byteOffset };
    case 0x080n:
      return { kind: 'queueDescLow', byteOffset };
    case 0x084n:
      return { kind: 'queueDescHigh', byteOffset };
    case 0x090n:
      return { kind: 'queueDriverLow', byteOffset };
    case 0x094n:
      return { kind: 'queueDriverHigh', byteOffset };
    case 0x0a0n:
      return { kind: 'queueDeviceLow', byteOffset };
    case 0x0a4n:
      return { kind: 'queueDeviceHigh', byteOffset };
    case 0x0fcn:
      return { kind: 'configGeneration', byteOffset };
    default:
      return null;
  }
};

const isValidVirtioQueueNum = (value: number): boolean =>
  value === 0 || value === 1 || value === 2 || value === 4 || value === 8;

export {
  VIRTIO_BLK_HEADER_BYTES,
  VIRTIO_BLK_S_IOERR,
  VIRTIO_BLK_S_OK,
  VIRTIO_BLK_S_UNSUPP,
  VIRTIO_BLK_SECTOR_BYTES,
  VIRTIO_BLK_T_IN,
  VIRTIO_BLK_T_OUT,
  VIRTIO_CONFIG_S_ACKNOWLEDGE,
  VIRTIO_CONFIG_S_DRIVER_OK,
  VIRTIO_CONFIG_S_FEATURES_OK,
  VIRTIO_DEVICE_FEATURES_HI,
  VIRTIO_DEVICE_FEATURES_LO,
  VIRTIO_DEVICE_ID_BLOCK,
  VIRTIO_MAX_TRANSFER_BYTES,
  VIRTIO_GUEST_BYTE_LENGTH,
  VIRTIO_HOST_BYTE_LENGTH,
  VIRTIO_HOST_CONFIG_GENERATION,
  VIRTIO_HOST_WAKE_SEQ,
  VIRTIO_HOST_QUEUE_EPOCH,
  VIRTIO_HOST_DEVICE_FEATURES_SEL,
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
  VIRTIO_HOST_QUEUE_NUM,
  VIRTIO_HOST_QUEUE_READY,
  VIRTIO_HOST_QUEUE_SEL,
  VIRTIO_HOST_QUEUE_NOTIFY,
  VIRTIO_HOST_QUEUE_NOTIFIED,
  VIRTIO_HOST_STATUS,
  VIRTIO_MAGIC_VALUE,
  VIRTIO_MAX_CHAIN_DESCRIPTORS,
  VIRTIO_MMIO_INT_VRING,
  VIRTIO_MMIO_INTERRUPT_ACK,
  VIRTIO_MMIO_QUEUE_NOTIFY,
  VIRTIO_MMIO_STATUS,
  VIRTIO_QUEUE_NUM_MAX,
  VIRTIO_REGION_ID,
  VIRTIO_VENDOR_ID,
  VIRTIO_VERSION,
  VRING_DESC_F_INDIRECT,
  VRING_DESC_F_NEXT,
  VRING_DESC_F_WRITE,
  isValidVirtioQueueNum,
  VIRTIO_HOST_DEVICE_PRESENT,
  virtioHostIndex,
  virtioHostInt32,
  virtioOffsetToLocation,
};
export type { VirtioRegisterKind };
