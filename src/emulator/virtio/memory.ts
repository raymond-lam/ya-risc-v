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
 * Virtio guest loadBytes / storeBytes — register decode, shadows, and
 * side effects (queue-notify kick, interrupt ack, device reset). When the device is absent
 * (devicePresent == 0) the window reads as all-zero and ignores stores.
 */

import type { ReadonlyUint8Array } from '#types';
import type { Memory } from '#emulator/memory';
import { setPlicSourcePending } from '#emulator/plic';
import { pollVirtioDiskCompletions } from '#emulator/virtio/queue';
import type { VirtioRegisterKind } from '#emulator/virtio/layout';
import {
  VIRTIO_BLK_SECTOR_BYTES,
  VIRTIO_CONFIG_S_ACKNOWLEDGE,
  VIRTIO_DEVICE_FEATURES_HI,
  VIRTIO_DEVICE_FEATURES_LO,
  VIRTIO_DEVICE_ID_BLOCK,
  VIRTIO_HOST_DEVICE_FEATURES_SEL,
  VIRTIO_HOST_DEVICE_PRESENT,
  VIRTIO_HOST_DRAINED_SEQ,
  VIRTIO_HOST_DRIVER_FEATURES_HI,
  VIRTIO_HOST_DRIVER_FEATURES_LO,
  VIRTIO_HOST_DRIVER_FEATURES_SEL,
  VIRTIO_HOST_INTERRUPT_STATUS,
  VIRTIO_HOST_LAST_AVAIL_IDX,
  VIRTIO_HOST_PENDING_DATA_ADDRESS,
  VIRTIO_HOST_PENDING_DATA_LENGTH,
  VIRTIO_HOST_PENDING_HEAD,
  VIRTIO_HOST_PENDING_STATUS_ADDRESS,
  VIRTIO_HOST_PENDING_USED_LEN,
  VIRTIO_HOST_QUEUE_DESC_HIGH,
  VIRTIO_HOST_QUEUE_DESC_LOW,
  VIRTIO_HOST_QUEUE_DEVICE_HIGH,
  VIRTIO_HOST_QUEUE_DEVICE_LOW,
  VIRTIO_HOST_QUEUE_DRIVER_HIGH,
  VIRTIO_HOST_QUEUE_DRIVER_LOW,
  VIRTIO_HOST_QUEUE_NUM,
  VIRTIO_HOST_QUEUE_READY,
  VIRTIO_HOST_QUEUE_SEL,
  VIRTIO_HOST_REQUEST_SEQ,
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
  loadVirtioDiskCapacity,
  loadVirtioShadowByte,
  loadVirtioShadowU32,
  storeVirtioShadowByte,
  storeVirtioShadowU32,
  virtioHostInt32,
  virtioOffsetToLocation,
} from '#emulator/virtio/layout';
import { PLIC_SOURCE_VIRTIO } from '#emulator/plic';

/** Byte `byteOffset` of an unsigned 32-bit host word. */
const byteOf = (value: number, byteOffset: number): number => (value >>> (byteOffset * 8)) & 0xff;

/** Byte `byteOffset` of an unsigned 64-bit host value. */
const byteOfBig = (value: bigint, byteOffset: number): number =>
  Number((value >> BigInt(byteOffset * 8)) & 0xffn);

/** Read one guest virtio byte; every register the device is absent reads 0. */
const loadVirtioByte = (memory: Memory, offset: bigint): number => {
  if (loadVirtioShadowU32(memory, VIRTIO_HOST_DEVICE_PRESENT) === 0) {
    return 0;
  }
  const location = virtioOffsetToLocation(offset);
  if (location === null) {
    return 0;
  }
  const { kind, byteOffset } = location;
  const queueSel = loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_SEL);
  switch (kind) {
    case 'magic':
      return byteOf(VIRTIO_MAGIC_VALUE, byteOffset);
    case 'version':
      return byteOf(VIRTIO_VERSION, byteOffset);
    case 'deviceId':
      return byteOf(VIRTIO_DEVICE_ID_BLOCK, byteOffset);
    case 'vendorId':
      return byteOf(VIRTIO_VENDOR_ID, byteOffset);
    case 'deviceFeatures': {
      const sel = loadVirtioShadowU32(memory, VIRTIO_HOST_DEVICE_FEATURES_SEL);
      const word =
        sel === 0 ? VIRTIO_DEVICE_FEATURES_LO : sel === 1 ? VIRTIO_DEVICE_FEATURES_HI : 0;
      return byteOf(word, byteOffset);
    }
    case 'queueNumMax':
      return queueSel === 0 ? byteOf(VIRTIO_QUEUE_NUM_MAX, byteOffset) : 0;
    case 'queueNum':
      return queueSel === 0 ? loadVirtioShadowByte(memory, VIRTIO_HOST_QUEUE_NUM, byteOffset) : 0;
    case 'queueReady':
      return queueSel === 0 ? loadVirtioShadowByte(memory, VIRTIO_HOST_QUEUE_READY, byteOffset) : 0;
    case 'interruptStatus':
      return loadVirtioShadowByte(memory, VIRTIO_HOST_INTERRUPT_STATUS, byteOffset);
    case 'status':
      return loadVirtioShadowByte(memory, VIRTIO_HOST_STATUS, byteOffset);
    case 'configCapacity':
      return byteOfBig(
        loadVirtioDiskCapacity(memory) / BigInt(VIRTIO_BLK_SECTOR_BYTES),
        byteOffset
      );
    default:
      // W-only registers, configGeneration, and every other read-as-zero register.
      return 0;
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

/** Per-byte write action; read-only registers are ignored. */
const storeVirtioByte = (memory: Memory, offset: bigint, value: number): void => {
  if (loadVirtioShadowU32(memory, VIRTIO_HOST_DEVICE_PRESENT) === 0) {
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
      if (queueSel !== 0) {
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
      if (queueSel === 0 && hostOffset !== undefined) {
        storeVirtioShadowByte(memory, hostOffset, byteOffset, byte);
      }
      return;
    }
    case 'status':
      storeVirtioShadowByte(memory, VIRTIO_HOST_STATUS, byteOffset, byte);
      return;
    default:
      // Read-only registers, plus queueNotify/interruptAck whose side effects fire
      // once the whole access has been written (see storeBytesToVirtio).
      return;
  }
};

/** Guest load of `byteLength` bytes from the virtio window at `offset`. */
const loadBytesFromVirtio = ({
  destination,
  memory,
  offset,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  byteLength: number;
}): void => {
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    destination[byteIndex] = loadVirtioByte(memory, offset + BigInt(byteIndex));
  }
};

/** True when the accessed byte span covers any byte of the 4-byte `registerOffset`. */
const coversRegister = (offset: bigint, byteLength: number, registerOffset: bigint): boolean =>
  offset < registerOffset + 4n && offset + BigInt(byteLength) > registerOffset;

/** Reset the device to its power-on shadows; swallow any in-flight completion once. */
const resetVirtioDevice = (memory: Memory): void => {
  const clearedHostOffsets = [
    VIRTIO_HOST_DEVICE_FEATURES_SEL,
    VIRTIO_HOST_DRIVER_FEATURES_LO,
    VIRTIO_HOST_DRIVER_FEATURES_HI,
    VIRTIO_HOST_DRIVER_FEATURES_SEL,
    VIRTIO_HOST_QUEUE_SEL,
    VIRTIO_HOST_QUEUE_NUM,
    VIRTIO_HOST_QUEUE_READY,
    VIRTIO_HOST_QUEUE_DESC_LOW,
    VIRTIO_HOST_QUEUE_DESC_HIGH,
    VIRTIO_HOST_QUEUE_DRIVER_LOW,
    VIRTIO_HOST_QUEUE_DRIVER_HIGH,
    VIRTIO_HOST_QUEUE_DEVICE_LOW,
    VIRTIO_HOST_QUEUE_DEVICE_HIGH,
    VIRTIO_HOST_LAST_AVAIL_IDX,
    VIRTIO_HOST_INTERRUPT_STATUS,
    VIRTIO_HOST_PENDING_HEAD,
    VIRTIO_HOST_PENDING_STATUS_ADDRESS,
    VIRTIO_HOST_PENDING_DATA_ADDRESS,
    VIRTIO_HOST_PENDING_DATA_LENGTH,
    VIRTIO_HOST_PENDING_USED_LEN,
  ];
  for (const hostOffset of clearedHostOffsets) {
    storeVirtioShadowU32(memory, hostOffset, 0);
  }
  // The two u64 pending-address fields span 8 bytes each; the u32 loop above only
  // cleared their low words, so clear the high words explicitly.
  storeVirtioShadowU32(memory, VIRTIO_HOST_PENDING_STATUS_ADDRESS + 4, 0);
  storeVirtioShadowU32(memory, VIRTIO_HOST_PENDING_DATA_ADDRESS + 4, 0);
  // Swallow any in-flight completion exactly once; do NOT touch requestSeq /
  // completionSeq / staging / capacity words — the disk worker owns the channel.
  storeVirtioShadowU32(
    memory,
    VIRTIO_HOST_DRAINED_SEQ,
    Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0) >>> 0
  );
  setPlicSourcePending(memory, PLIC_SOURCE_VIRTIO, false);
};

/** QueueNotify kick: a store of 0 (queue 0) drains and submits. */
const handleQueueNotify = (
  memory: Memory,
  offset: bigint,
  byteLength: number,
  source: ReadonlyUint8Array
): void => {
  if (!coversRegister(offset, byteLength, VIRTIO_MMIO_QUEUE_NOTIFY)) {
    return;
  }
  const notifyIndex = Number(VIRTIO_MMIO_QUEUE_NOTIFY - offset);
  // 0 <= notifyIndex < byteLength: the access covers the register's low byte (a store to
  // an upper byte of QueueNotify must not kick — it does not write the queue index).
  if (notifyIndex >= 0 && (source[notifyIndex] ?? 0) === 0) {
    pollVirtioDiskCompletions(memory);
  }
};

/** InterruptACK: bit 0 clears the interrupt and deasserts PLIC source 1. */
const handleInterruptAck = (
  memory: Memory,
  offset: bigint,
  byteLength: number,
  source: ReadonlyUint8Array
): void => {
  if (!coversRegister(offset, byteLength, VIRTIO_MMIO_INTERRUPT_ACK)) {
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

/** Status: a stored word with ACKNOWLEDGE clear resets the device. */
const handleStatusWrite = (memory: Memory, offset: bigint, byteLength: number): void => {
  if (!coversRegister(offset, byteLength, VIRTIO_MMIO_STATUS)) {
    return;
  }
  if ((loadVirtioShadowU32(memory, VIRTIO_HOST_STATUS) & VIRTIO_CONFIG_S_ACKNOWLEDGE) === 0) {
    resetVirtioDevice(memory);
  }
};

/** Guest store of `byteLength` bytes into the virtio window, then whole-access side effects. */
const storeBytesToVirtio = ({
  memory,
  offset,
  source,
  byteLength,
}: {
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  source: ReadonlyUint8Array;
  byteLength: number;
}): void => {
  if (loadVirtioShadowU32(memory, VIRTIO_HOST_DEVICE_PRESENT) === 0) {
    return;
  }
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    storeVirtioByte(memory, offset + BigInt(byteIndex), source[byteIndex] ?? 0);
  }
  // Side effects run after the byte loop so a register word is fully assembled first:
  // firing the kick or the reset mid-word would act on a half-written value.
  handleQueueNotify(memory, offset, byteLength, source);
  handleInterruptAck(memory, offset, byteLength, source);
  handleStatusWrite(memory, offset, byteLength);
};

export { loadBytesFromVirtio, storeBytesToVirtio };
