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

/** Worker-owned split queue: immutable claims and epoch-checked publication.
 * Callers hold reservation and PLIC/control locks; these operations never await. */

import type { ReadonlyUint8Array } from '#types';
import type { Memory } from '#emulator/memory';
import { PLIC_SOURCE_VIRTIO, setPlicSourcePending } from '#emulator/plic';
import { guestRamOffset, loadBytesFromRam, storeBytesToRam } from '#emulator/ram';
import {
  VIRTIO_BLK_HEADER_BYTES,
  VIRTIO_BLK_S_IOERR,
  VIRTIO_BLK_S_OK,
  VIRTIO_BLK_S_UNSUPP,
  VIRTIO_BLK_SECTOR_BYTES,
  VIRTIO_BLK_T_IN,
  VIRTIO_BLK_T_OUT,
  VIRTIO_CONFIG_S_DRIVER_OK,
  VIRTIO_MAX_TRANSFER_BYTES,
  VIRTIO_HOST_INTERRUPT_STATUS,
  VIRTIO_HOST_QUEUE_DESC_HIGH,
  VIRTIO_HOST_QUEUE_DESC_LOW,
  VIRTIO_HOST_QUEUE_DEVICE_HIGH,
  VIRTIO_HOST_QUEUE_DEVICE_LOW,
  VIRTIO_HOST_QUEUE_DRIVER_HIGH,
  VIRTIO_HOST_QUEUE_DRIVER_LOW,
  VIRTIO_HOST_QUEUE_NUM,
  VIRTIO_HOST_QUEUE_READY,
  VIRTIO_HOST_STATUS,
  VIRTIO_HOST_QUEUE_EPOCH,
  VIRTIO_MAX_CHAIN_DESCRIPTORS,
  VIRTIO_MMIO_INT_VRING,
  VIRTIO_QUEUE_NUM_MAX,
  VRING_DESC_F_INDIRECT,
  VRING_DESC_F_NEXT,
  VRING_DESC_F_WRITE,
} from '#emulator/virtio/layout';
import {
  loadVirtioDevicePresent,
  loadVirtioDiskCapacity,
  loadVirtioShadowU32,
  storeVirtioShadowU32,
} from '#emulator/virtio/registers';
import { addBytes, bytesToBigInt, bytesToNumber, unsignedNumberToBytes } from '#utils/bytes';

type VirtioDescriptor = {
  address: ReadonlyUint8Array; // guest phys addr of the buffer
  length: number; // u32 len
  flags: number; // u16
  next: number; // u16
};

type VirtioQueueConfig = {
  queueNum: number;
  descBase: ReadonlyUint8Array;
  driverBase: ReadonlyUint8Array;
  deviceBase: ReadonlyUint8Array;
};

/** One data buffer segment of a block request (may be many, e.g. Linux bio_vec pages). */
type DataSegment = { address: ReadonlyUint8Array; length: number };

/** What to do with one parsed slot. */
type VirtioRequestPlan =
  | { kind: 'sync'; statusByte: number } // complete now (no file I/O); usedLen is always 1
  | {
      kind: 'read';
      sectorOffset: bigint;
      dataLength: number;
      dataSegments: readonly DataSegment[];
    } // submit to disk worker (IN)
  | {
      kind: 'write';
      sectorOffset: bigint;
      dataLength: number;
      dataSegments: readonly DataSegment[];
    }; // submit (OUT)

type VirtioQueueState = { epoch: number; lastAvail: number; kicked: boolean };
type VirtioRequest = {
  epoch: number;
  config: VirtioQueueConfig;
  head: number;
  statusAddress: ReadonlyUint8Array;
  plan: VirtioRequestPlan;
  data: Uint8Array;
};

/** Guest address `offset` bytes past `base`; offsets are small host-computed numbers. */
const guestAddressAt = (base: ReadonlyUint8Array, offset: number): Uint8Array =>
  addBytes(new Uint8Array(8), base, unsignedNumberToBytes(new Uint8Array(8), offset));

/** Load a guest u16 via DMA; null when the address is outside RAM. */
const loadGuestU16 = (memory: Memory, address: ReadonlyUint8Array): number | null => {
  const word = new Uint8Array(2);
  const offset = guestRamOffset(memory, address, 2);
  if (offset === null) {
    return null;
  }
  loadBytesFromRam({ destination: word, memory, address, offset, byteLength: 2 });
  return (word[0] ?? 0) | ((word[1] ?? 0) << 8);
};

/** Assemble a guest ring base address from its high/low shadow-register pair. */
const ringBase = (memory: Memory, high: number, low: number): Uint8Array => {
  const base = new Uint8Array(8);
  unsignedNumberToBytes(base.subarray(0, 4), loadVirtioShadowU32(memory, low));
  unsignedNumberToBytes(base.subarray(4, 8), loadVirtioShadowU32(memory, high));
  return base;
};

/** Ready + activated queue 0, or null while the driver has not set it up. */
const loadVirtioDiskQueueConfig = (memory: Memory): VirtioQueueConfig | null => {
  if (loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_READY) === 0) {
    return null;
  }
  const queueNum = loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_NUM);
  if (queueNum === 0 || queueNum > VIRTIO_QUEUE_NUM_MAX) {
    return null;
  }
  if ((loadVirtioShadowU32(memory, VIRTIO_HOST_STATUS) & VIRTIO_CONFIG_S_DRIVER_OK) === 0) {
    return null;
  }
  const descBase = ringBase(memory, VIRTIO_HOST_QUEUE_DESC_HIGH, VIRTIO_HOST_QUEUE_DESC_LOW);
  const driverBase = ringBase(memory, VIRTIO_HOST_QUEUE_DRIVER_HIGH, VIRTIO_HOST_QUEUE_DRIVER_LOW);
  const deviceBase = ringBase(memory, VIRTIO_HOST_QUEUE_DEVICE_HIGH, VIRTIO_HOST_QUEUE_DEVICE_LOW);
  // Alignment lives in the low bits, i.e. byte 0 of the little-endian address.
  if (
    ((descBase[0] ?? 0) & 15) !== 0 ||
    ((driverBase[0] ?? 0) & 1) !== 0 ||
    ((deviceBase[0] ?? 0) & 3) !== 0
  ) {
    return null;
  }
  if (
    guestRamOffset(memory, descBase, queueNum * 16) === null ||
    guestRamOffset(memory, driverBase, 4 + queueNum * 2) === null ||
    guestRamOffset(memory, deviceBase, 4 + queueNum * 8) === null
  ) {
    return null;
  }
  return { queueNum, descBase, driverBase, deviceBase };
};

/** Read one 16-byte descriptor; null when unreadable or INDIRECT. */
const readDescriptorAt = (
  memory: Memory,
  config: VirtioQueueConfig,
  index: number
): VirtioDescriptor | null => {
  const raw = new Uint8Array(16);
  const guestAddress = guestAddressAt(config.descBase, 16 * index);
  const offset = guestRamOffset(memory, guestAddress, 16);
  if (offset === null) {
    return null; // descriptor table outside RAM
  }
  loadBytesFromRam({ destination: raw, memory, address: guestAddress, offset, byteLength: 16 });
  const flags = (raw[12] ?? 0) | ((raw[13] ?? 0) << 8);
  if ((flags & VRING_DESC_F_INDIRECT) !== 0) {
    return null;
  }
  return {
    address: raw.slice(0, 8), // snapshot; the stored address must not alias descriptor memory
    length: bytesToNumber(raw.subarray(8, 12)),
    flags,
    next: (raw[14] ?? 0) | ((raw[15] ?? 0) << 8),
  };
};

/** Bounded NEXT walk from `head`; null on any unreadable or malformed chain. */
const readDescriptorChain = (
  memory: Memory,
  config: VirtioQueueConfig,
  head: number
): readonly VirtioDescriptor[] | null => {
  if (head >= config.queueNum) {
    return null;
  }
  const descriptors: VirtioDescriptor[] = [];
  let index = head;
  for (;;) {
    const descriptor = readDescriptorAt(memory, config, index);
    if (descriptor === null) {
      return null;
    }
    descriptors.push(descriptor);
    if (descriptors.length > VIRTIO_MAX_CHAIN_DESCRIPTORS) {
      return null; // cycle guard
    }
    if ((descriptor.flags & VRING_DESC_F_NEXT) === 0) {
      return descriptors; // terminal
    }
    if (descriptor.next >= config.queueNum) {
      return null;
    }
    index = descriptor.next;
  }
};

/** The trailing WRITE-only, single-byte status descriptor, or undefined. */
const trailingStatusDescriptor = (
  descriptors: readonly VirtioDescriptor[]
): VirtioDescriptor | undefined => {
  const last = descriptors[descriptors.length - 1];
  if (last === undefined) {
    return undefined;
  }
  // INDIRECT is already rejected by readDescriptorAt, the only source of these chains.
  const isStatus =
    (last.flags & VRING_DESC_F_WRITE) !== 0 &&
    (last.flags & VRING_DESC_F_NEXT) === 0 &&
    last.length === 1;
  return isStatus ? last : undefined;
};

/** In-bounds whole-sector transfer within the published capacity. */
const isValidTransferBounds = (sector: bigint, dataLength: number, capacity: bigint): boolean => {
  if (capacity === 0n) {
    return false;
  }
  const offsetBytes = sector * BigInt(VIRTIO_BLK_SECTOR_BYTES);
  return (
    offsetBytes <= BigInt(Number.MAX_SAFE_INTEGER) && offsetBytes + BigInt(dataLength) <= capacity
  );
};

/**
 * Extract and validate a chain's data section (§FIX 5). The section is the descriptors
 * between the header (index 0) and the trailing status descriptor: one or more
 * same-direction segments whose lengths sum to the transfer length. Returns null on an
 * empty data section, a mixed-direction section, or a transfer longer than the worker-local
 * buffer limit — all of which complete the request with IOERR (the chain has a status
 * descriptor, so it has somewhere to record the error).
 */
const dataSection = (
  descriptors: readonly VirtioDescriptor[]
): { segments: DataSegment[]; dataWritable: boolean; dataLength: number } | null => {
  const dataDescriptors = descriptors.slice(1, descriptors.length - 1);
  const first = dataDescriptors[0];
  if (first === undefined) {
    return null;
  }
  const dataWritable = (first.flags & VRING_DESC_F_WRITE) !== 0;
  const segments: DataSegment[] = [];
  let dataLength = 0;
  for (const descriptor of dataDescriptors) {
    if (((descriptor.flags & VRING_DESC_F_WRITE) !== 0) !== dataWritable) {
      return null; // mixed direction within one request is invalid
    }
    dataLength += descriptor.length;
    if (dataLength > VIRTIO_MAX_TRANSFER_BYTES) {
      return null; // exceeds the worker-local transfer buffer limit
    }
    segments.push({ address: descriptor.address, length: descriptor.length });
  }
  if (dataLength < 1) {
    return null;
  }
  return { segments, dataWritable, dataLength };
};

/** Classify one chain into a plan; null = skip the slot (nowhere to write a status byte). */
const planBlockRequest = (
  memory: Memory,
  descriptors: readonly VirtioDescriptor[]
): VirtioRequestPlan | null => {
  const headerDescriptor = descriptors[0];
  if (headerDescriptor === undefined) {
    return null;
  }
  if (
    headerDescriptor.flags !== VRING_DESC_F_NEXT || // exactly NEXT
    headerDescriptor.length < VIRTIO_BLK_HEADER_BYTES
  ) {
    return { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR };
  }

  const header = new Uint8Array(VIRTIO_BLK_HEADER_BYTES);
  const headerOffset = guestRamOffset(memory, headerDescriptor.address, VIRTIO_BLK_HEADER_BYTES);
  if (headerOffset === null) {
    return { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR };
  }
  loadBytesFromRam({
    destination: header,
    memory,
    address: headerDescriptor.address,
    offset: headerOffset,
    byteLength: VIRTIO_BLK_HEADER_BYTES,
  });

  const type = bytesToNumber(header.subarray(0, 4));
  const sector = bytesToBigInt(header.subarray(8, 16));
  // Unadvertised operations (including FLUSH) never become successful no-ops.
  if (type !== VIRTIO_BLK_T_IN && type !== VIRTIO_BLK_T_OUT) {
    return { kind: 'sync', statusByte: VIRTIO_BLK_S_UNSUPP };
  }
  const section = dataSection(descriptors);
  if (section === null) {
    return { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR };
  }

  const capacity = loadVirtioDiskCapacity(memory); // 0 until the worker publishes

  switch (type) {
    case VIRTIO_BLK_T_IN:
      // IN read: the device writes the data, so the data section must be WRITE-flagged.
      if (!section.dataWritable || !isValidTransferBounds(sector, section.dataLength, capacity)) {
        return { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR };
      }
      return {
        kind: 'read',
        sectorOffset: sector * BigInt(VIRTIO_BLK_SECTOR_BYTES),
        dataLength: section.dataLength,
        dataSegments: section.segments,
      };
    case VIRTIO_BLK_T_OUT:
      // OUT write: the device reads the data, so the data section must not be WRITE-flagged.
      if (section.dataWritable || !isValidTransferBounds(sector, section.dataLength, capacity)) {
        return { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR };
      }
      return {
        kind: 'write',
        sectorOffset: sector * BigInt(VIRTIO_BLK_SECTOR_BYTES),
        dataLength: section.dataLength,
        dataSegments: section.segments,
      };
    default:
      return { kind: 'sync', statusByte: VIRTIO_BLK_S_UNSUPP };
  }
};

/** 1. status byte → 2+3. used-ring entry → idx bump; true when the entry landed. */
const appendUsedEntry = (
  memory: Memory,
  config: VirtioQueueConfig,
  head: number,
  usedLen: number
): boolean => {
  const idxAddress = guestAddressAt(config.deviceBase, 2);
  const usedIdx = loadGuestU16(memory, idxAddress);
  if (usedIdx === null) {
    return false;
  }
  const slot = usedIdx % config.queueNum;
  const entryAddress = guestAddressAt(config.deviceBase, 4 + slot * 8);
  // One whole-span gate, then two logical 4-byte writes (entry is only 4-byte aligned).
  const entryOffset = guestRamOffset(memory, entryAddress, 8);
  if (entryOffset === null) {
    return false;
  }
  storeBytesToRam({
    memory,
    address: entryAddress,
    offset: entryOffset,
    source: unsignedNumberToBytes(new Uint8Array(8), head),
    byteLength: 4,
  });
  storeBytesToRam({
    memory,
    address: guestAddressAt(config.deviceBase, 8 + slot * 8),
    offset: entryOffset + 4n,
    source: unsignedNumberToBytes(new Uint8Array(8), usedLen),
    byteLength: 4,
  });
  const idxOffset = guestRamOffset(memory, idxAddress, 2);
  if (idxOffset === null) {
    return false;
  }
  storeBytesToRam({
    memory,
    address: idxAddress,
    offset: idxOffset,
    source: unsignedNumberToBytes(new Uint8Array(8), (usedIdx + 1) & 0xffff),
    byteLength: 2,
  });
  return true;
};

/** Publish one completion to the guest: status byte first, then the used entry. */
const publishCompletedVirtioSlot = (
  memory: Memory,
  config: VirtioQueueConfig,
  head: number,
  statusAddress: ReadonlyUint8Array,
  statusByte: number,
  usedLen: number
): boolean => {
  // 1. status byte FIRST (xv6 requires status == 0 by the time it sees the used entry);
  //    a status store that misses RAM is dropped and still publishes the used entry, the
  //    guest's only progress signal.
  const statusOffset = guestRamOffset(memory, statusAddress, 1);
  if (statusOffset !== null) {
    storeBytesToRam({
      memory,
      address: statusAddress,
      offset: statusOffset,
      source: new Uint8Array([statusByte]),
      byteLength: 1,
    });
  }
  return appendUsedEntry(memory, config, head, usedLen);
};

/** Gather the guest data segments into the worker-local transfer buffer (OUT), in order. */
const stageGuestData = (
  memory: Memory,
  segments: readonly DataSegment[],
  staging: Uint8Array
): boolean => {
  let offset = 0;
  for (const segment of segments) {
    const segmentOffset = guestRamOffset(memory, segment.address, segment.length);
    if (segmentOffset === null) {
      return false;
    }
    loadBytesFromRam({
      destination: staging.subarray(offset, offset + segment.length),
      memory,
      address: segment.address,
      offset: segmentOffset,
      byteLength: segment.length,
    });
    offset += segment.length;
  }
  return true;
};

/** Scatter the worker-local transfer buffer across the guest data segments (IN), in order. */
const storeStagingData = (
  memory: Memory,
  segments: readonly DataSegment[],
  staging: Uint8Array
): boolean => {
  let offset = 0;
  for (const segment of segments) {
    const segmentOffset = guestRamOffset(memory, segment.address, segment.length);
    if (segmentOffset === null) {
      return false;
    }
    storeBytesToRam({
      memory,
      address: segment.address,
      offset: segmentOffset,
      source: staging.subarray(offset, offset + segment.length),
      byteLength: segment.length,
    });
    offset += segment.length;
  }
  return true;
};

/** Claim at most one available slot; malformed work is bounded by queue depth. */
const claimVirtioRequest = (memory: Memory, state: VirtioQueueState): VirtioRequest | null => {
  const epoch = loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_EPOCH);
  if (state.epoch !== epoch) {
    state.epoch = epoch;
    state.lastAvail = 0;
    state.kicked = false;
  }
  if (!state.kicked || loadVirtioDevicePresent(memory) === 0) return null;
  const config = loadVirtioDiskQueueConfig(memory);
  if (config === null) return null;
  const avail = loadGuestU16(memory, guestAddressAt(config.driverBase, 2));
  if (avail === null || avail === state.lastAvail) return null;
  if (((avail - state.lastAvail) & 0xffff) > config.queueNum) {
    // Invalid driver input: do not fabricate submissions or advance lastAvail.
    // Re-notifying this same oversized index stalls again; a valid index or reset is required.
    state.kicked = false;
    return null;
  }
  const slot = state.lastAvail % config.queueNum;
  state.lastAvail = (state.lastAvail + 1) & 0xffff;
  const head = loadGuestU16(memory, guestAddressAt(config.driverBase, 4 + slot * 2));
  return head === null ? null : prepareVirtioRequest(memory, config, head, epoch);
};
const prepareVirtioRequest = (
  memory: Memory,
  config: VirtioQueueConfig,
  head: number,
  epoch: number
): VirtioRequest | null => {
  const descriptors = readDescriptorChain(memory, config, head);
  if (descriptors === null) return null;
  const status = trailingStatusDescriptor(descriptors);
  if (status === undefined) return null;
  let plan = planBlockRequest(memory, descriptors);
  if (plan === null) return null;
  // Invalid-descriptor policy: consume the available slot without DMA/used publication
  // when its status byte cannot be written; lastAvail was advanced by the claim.
  if (guestRamOffset(memory, status.address, 1) === null) return null;
  if (
    plan.kind === 'read' &&
    plan.dataSegments.some(
      (segment) => guestRamOffset(memory, segment.address, segment.length) === null
    )
  ) {
    plan = { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR };
  }
  let data = new Uint8Array(plan.kind === 'sync' ? 0 : plan.dataLength);
  // For writes, staging doubles as the segment-mapping preflight: guestRamOffset is pure
  // against the static region map, and a partial stage into the local buffer is unobservable.
  if (plan.kind === 'write' && !stageGuestData(memory, plan.dataSegments, data)) {
    plan = { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR };
    data = new Uint8Array(0);
  }
  return { epoch, config, head, statusAddress: status.address, plan, data };
};

/** Reset/deactivation serialize with this entire bounded publication, never with file I/O. */
const completeVirtioRequest = (memory: Memory, request: VirtioRequest, ioError: boolean): void => {
  if (
    request.epoch !== loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_EPOCH) ||
    loadVirtioDiskQueueConfig(memory) === null
  )
    return;
  const { plan } = request;
  if (!ioError && plan.kind === 'read') storeStagingData(memory, plan.dataSegments, request.data);
  const statusByte =
    plan.kind === 'sync' ? plan.statusByte : ioError ? VIRTIO_BLK_S_IOERR : VIRTIO_BLK_S_OK;
  const usedLen =
    plan.kind === 'sync' ? 1 : !ioError && plan.kind === 'read' ? plan.dataLength + 1 : 1;
  if (
    publishCompletedVirtioSlot(
      memory,
      request.config,
      request.head,
      request.statusAddress,
      statusByte,
      usedLen
    )
  ) {
    storeVirtioShadowU32(
      memory,
      VIRTIO_HOST_INTERRUPT_STATUS,
      loadVirtioShadowU32(memory, VIRTIO_HOST_INTERRUPT_STATUS) | VIRTIO_MMIO_INT_VRING
    );
    setPlicSourcePending(memory, PLIC_SOURCE_VIRTIO, true);
  }
};

export { claimVirtioRequest, completeVirtioRequest };
export type { VirtioQueueState };
