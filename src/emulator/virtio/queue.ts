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
 * Split-virtqueue engine for the virtio block device (CPU worker only).
 *
 * serviceVirtioDiskQueue services pending work: it drains a completed disk-worker request
 * (staging→guest DMA, status byte, used-ring entry, idx bump) and submits the next request
 * when the channel is idle. It does not poll or wait — callers invoke it per fetch, on
 * QueueNotify, and after the completion wake word resolves. Guest RAM stays single-writer:
 * this module performs every guest-visible write; the disk worker only touches the staging
 * window and its channel words. Publication order per request: status byte → used-ring
 * entry → used->idx bump → PLIC source-1 assert. One request is in flight at a time
 * (deliberate serialization).
 */

import type { ReadonlyUint8Array } from '#types';
import type { Memory } from '#emulator/memory';
import { PLIC_SOURCE_VIRTIO, setPlicSourcePending } from '#emulator/plic';
import { publishWakeLevel, waitWake } from '#emulator/wake';
import { loadGuestRamBytes, storeGuestRamBytes } from '#emulator/dma';
import {
  VIRTIO_BLK_HEADER_BYTES,
  VIRTIO_BLK_S_IOERR,
  VIRTIO_BLK_S_OK,
  VIRTIO_BLK_S_UNSUPP,
  VIRTIO_BLK_SECTOR_BYTES,
  VIRTIO_BLK_T_FLUSH,
  VIRTIO_BLK_T_IN,
  VIRTIO_BLK_T_OUT,
  VIRTIO_CONFIG_S_DRIVER_OK,
  VIRTIO_DISK_STAGING_BYTES,
  VIRTIO_HOST_COMPLETION_SEQ,
  VIRTIO_HOST_DRAINED_SEQ,
  VIRTIO_HOST_INTERRUPT_STATUS,
  VIRTIO_HOST_LAST_AVAIL_IDX,
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
  VIRTIO_HOST_REQUEST_DIRECTION,
  VIRTIO_HOST_REQUEST_IO_ERROR,
  VIRTIO_HOST_REQUEST_LENGTH,
  VIRTIO_HOST_REQUEST_SECTOR_HIGH,
  VIRTIO_HOST_REQUEST_SECTOR_LOW,
  VIRTIO_HOST_REQUEST_SEQ,
  VIRTIO_HOST_STAGING,
  VIRTIO_HOST_STATUS,
  VIRTIO_MAX_CHAIN_DESCRIPTORS,
  VIRTIO_MMIO_INT_VRING,
  VIRTIO_QUEUE_NUM_MAX,
  VRING_DESC_F_INDIRECT,
  VRING_DESC_F_NEXT,
  VRING_DESC_F_WRITE,
  loadVirtioDevicePresent,
  loadVirtioDiskCapacity,
  loadVirtioShadowU32,
  storeVirtioShadowU32,
  virtioHostBigUint64,
  virtioHostIndex,
  virtioHostInt32,
} from '#emulator/virtio/layout';
import {
  bytesToBigInt,
  bytesToNumber,
  unsignedBigIntToBytes,
  unsignedNumberToBytes,
} from '#utils/bytes';

type VirtioDescriptor = {
  address: bigint; // guest phys addr of the buffer
  length: number; // u32 len
  flags: number; // u16
  next: number; // u16
};

type VirtioQueueConfig = {
  queueNum: number;
  descBase: bigint;
  driverBase: bigint;
  deviceBase: bigint;
};

/** One data buffer segment of a block request (may be many, e.g. Linux bio_vec pages). */
type DataSegment = { address: bigint; length: number };

/** What to do with one parsed slot. */
type VirtioRequestPlan =
  | { kind: 'sync'; statusByte: number; usedLen: number } // complete now (no file I/O)
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

type VirtioSlotResult = 'published' | 'submitted' | 'skip';

const VIRTIO_SLOT_PUBLISHED: VirtioSlotResult = 'published';
const VIRTIO_SLOT_SUBMITTED: VirtioSlotResult = 'submitted';
const VIRTIO_SLOT_SKIP: VirtioSlotResult = 'skip';

/**
 * Data segments of the in-flight request (CPU-worker-local, not the disk channel): the
 * staging window holds one contiguous transfer, and this list remembers where to scatter
 * it (IN) or gather it from (OUT) across the guest's data descriptors. Single-flight means
 * one request is in flight at a time, so a single module binding is sufficient.
 */
let pendingDataSegments: readonly DataSegment[] = [];

const virtioGuestAddress = (address: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), address) as ReadonlyUint8Array;

/** Load a guest u16 via DMA; null when the address is outside RAM. */
const loadGuestU16 = (memory: Memory, address: bigint): number | null => {
  const word = new Uint8Array(2);
  if (
    !loadGuestRamBytes({
      destination: word,
      memory,
      address: virtioGuestAddress(address),
      byteLength: 2,
    })
  ) {
    return null;
  }
  return (word[0] ?? 0) | ((word[1] ?? 0) << 8);
};

/** Current completion wake-word level (unsigned). */
const loadVirtioDiskCompletionSeq = (memory: Memory): number =>
  Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_COMPLETION_SEQ), 0) >>> 0;

/** Current request wake-word level (unsigned). */
const loadVirtioDiskRequestSeq = (memory: Memory): number =>
  Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_SEQ), 0) >>> 0;

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
  const descBase =
    (BigInt(loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_DESC_HIGH)) << 32n) |
    BigInt(loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_DESC_LOW));
  const driverBase =
    (BigInt(loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_DRIVER_HIGH)) << 32n) |
    BigInt(loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_DRIVER_LOW));
  const deviceBase =
    (BigInt(loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_DEVICE_HIGH)) << 32n) |
    BigInt(loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_DEVICE_LOW));
  return { queueNum, descBase, driverBase, deviceBase };
};

/** Read one 16-byte descriptor; null when unreadable or INDIRECT. */
const readDescriptorAt = (
  memory: Memory,
  config: VirtioQueueConfig,
  index: number
): VirtioDescriptor | null => {
  const raw = new Uint8Array(16);
  if (
    !loadGuestRamBytes({
      destination: raw,
      memory,
      address: virtioGuestAddress(config.descBase + 16n * BigInt(index)),
      byteLength: 16,
    })
  ) {
    return null; // descriptor table outside RAM
  }
  const flags = (raw[12] ?? 0) | ((raw[13] ?? 0) << 8);
  if ((flags & VRING_DESC_F_INDIRECT) !== 0) {
    return null;
  }
  return {
    address: bytesToBigInt(raw.subarray(0, 8)),
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
  const isStatus =
    (last.flags & VRING_DESC_F_WRITE) !== 0 &&
    (last.flags & VRING_DESC_F_NEXT) === 0 &&
    (last.flags & VRING_DESC_F_INDIRECT) === 0 &&
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
 * empty data section, a mixed-direction section, or a transfer longer than the staging
 * window — all of which complete the request with IOERR (the chain has a status
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
    if (dataLength > VIRTIO_DISK_STAGING_BYTES) {
      return null; // exceeds the device's max transfer (staging window)
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
  const statusDescriptor = trailingStatusDescriptor(descriptors);
  if (statusDescriptor === undefined) {
    return null;
  }
  const headerDescriptor = descriptors[0];
  if (headerDescriptor === undefined) {
    return null;
  }
  if (
    headerDescriptor.flags !== VRING_DESC_F_NEXT || // exactly NEXT
    headerDescriptor.length < VIRTIO_BLK_HEADER_BYTES
  ) {
    return { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR, usedLen: 1 };
  }

  const section = dataSection(descriptors);
  if (section === null) {
    return { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR, usedLen: 1 };
  }

  const header = new Uint8Array(VIRTIO_BLK_HEADER_BYTES);
  if (
    !loadGuestRamBytes({
      destination: header,
      memory,
      address: virtioGuestAddress(headerDescriptor.address),
      byteLength: VIRTIO_BLK_HEADER_BYTES,
    })
  ) {
    return { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR, usedLen: 1 };
  }

  const type = bytesToNumber(header.subarray(0, 4));
  const sector = bytesToBigInt(header.subarray(8, 16));
  const capacity = loadVirtioDiskCapacity(memory); // 0 until the worker publishes

  switch (type) {
    case VIRTIO_BLK_T_IN:
      // IN read: the device writes the data, so the data section must be WRITE-flagged.
      if (!section.dataWritable || !isValidTransferBounds(sector, section.dataLength, capacity)) {
        return { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR, usedLen: 1 };
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
        return { kind: 'sync', statusByte: VIRTIO_BLK_S_IOERR, usedLen: 1 };
      }
      return {
        kind: 'write',
        sectorOffset: sector * BigInt(VIRTIO_BLK_SECTOR_BYTES),
        dataLength: section.dataLength,
        dataSegments: section.segments,
      };
    case VIRTIO_BLK_T_FLUSH: // synchronous writes: no-op
      return { kind: 'sync', statusByte: VIRTIO_BLK_S_OK, usedLen: 1 };
    default:
      return { kind: 'sync', statusByte: VIRTIO_BLK_S_UNSUPP, usedLen: 1 };
  }
};

/** 1. status byte → 2+3. used-ring entry → idx bump; true when the entry landed. */
const appendUsedEntry = (
  memory: Memory,
  config: VirtioQueueConfig,
  head: number,
  usedLen: number
): boolean => {
  const usedIdx = loadGuestU16(memory, config.deviceBase + 2n);
  if (usedIdx === null) {
    return false;
  }
  const slot = usedIdx % config.queueNum;
  const entryAddress = config.deviceBase + 4n + BigInt(slot * 8);
  const idWord = unsignedNumberToBytes(new Uint8Array(8), head);
  const lenWord = unsignedNumberToBytes(new Uint8Array(8), usedLen);
  const idxWord = unsignedNumberToBytes(new Uint8Array(8), (usedIdx + 1) & 0xffff);
  if (
    !storeGuestRamBytes({
      memory,
      address: virtioGuestAddress(entryAddress),
      source: idWord,
      byteLength: 4,
    })
  ) {
    return false;
  }
  if (
    !storeGuestRamBytes({
      memory,
      address: virtioGuestAddress(entryAddress + 4n),
      source: lenWord,
      byteLength: 4,
    })
  ) {
    return false;
  }
  return storeGuestRamBytes({
    memory,
    address: virtioGuestAddress(config.deviceBase + 2n),
    source: idxWord,
    byteLength: 2,
  });
};

/** Publish one completion to the guest: status byte first, then the used entry. */
const publishCompletedVirtioSlot = (
  memory: Memory,
  config: VirtioQueueConfig,
  head: number,
  statusAddress: bigint,
  statusByte: number,
  usedLen: number
): boolean => {
  // 1. status byte FIRST (xv6 requires status == 0 by the time it sees the used entry);
  //    a failed status store (address outside RAM) still publishes the used entry, the
  //    guest's only progress signal.
  storeGuestRamBytes({
    memory,
    address: virtioGuestAddress(statusAddress),
    source: new Uint8Array([statusByte]),
    byteLength: 1,
  });
  return appendUsedEntry(memory, config, head, usedLen);
};

/** Gather the guest data segments into the contiguous staging window (OUT), in order. */
const stageGuestData = (
  memory: Memory,
  segments: readonly DataSegment[],
  staging: Uint8Array
): boolean => {
  let offset = 0;
  for (const segment of segments) {
    if (
      !loadGuestRamBytes({
        destination: staging.subarray(offset, offset + segment.length),
        memory,
        address: virtioGuestAddress(segment.address),
        byteLength: segment.length,
      })
    ) {
      return false;
    }
    offset += segment.length;
  }
  return true;
};

/** Scatter the contiguous staging window across the guest data segments (IN), in order. */
const storeStagingData = (
  memory: Memory,
  segments: readonly DataSegment[],
  staging: Uint8Array
): boolean => {
  let offset = 0;
  for (const segment of segments) {
    if (
      !storeGuestRamBytes({
        memory,
        address: virtioGuestAddress(segment.address),
        source: staging.subarray(offset, offset + segment.length),
        byteLength: segment.length,
      })
    ) {
      return false;
    }
    offset += segment.length;
  }
  return true;
};

/** Fill the channel words and wake the disk worker for one read/write request. */
const submitVirtioRequest = (
  memory: Memory,
  head: number,
  statusAddress: bigint,
  plan: Exclude<VirtioRequestPlan, { kind: 'sync' }>
): void => {
  storeVirtioShadowU32(memory, VIRTIO_HOST_PENDING_HEAD, head);
  virtioHostBigUint64(memory, VIRTIO_HOST_PENDING_STATUS_ADDRESS)[0] = statusAddress;
  pendingDataSegments = plan.dataSegments;
  storeVirtioShadowU32(memory, VIRTIO_HOST_PENDING_DATA_LENGTH, plan.dataLength);
  storeVirtioShadowU32(
    memory,
    VIRTIO_HOST_PENDING_USED_LEN,
    plan.kind === 'read' ? plan.dataLength + 1 : 1
  );
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_IO_ERROR), 0, 0);
  Atomics.store(
    virtioHostInt32(memory, VIRTIO_HOST_REQUEST_DIRECTION),
    0,
    plan.kind === 'read' ? VIRTIO_BLK_T_IN : VIRTIO_BLK_T_OUT
  );
  Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_LENGTH), 0, plan.dataLength);
  storeVirtioShadowU32(
    memory,
    VIRTIO_HOST_REQUEST_SECTOR_LOW,
    Number(plan.sectorOffset & 0xffff_ffffn)
  );
  storeVirtioShadowU32(
    memory,
    VIRTIO_HOST_REQUEST_SECTOR_HIGH,
    Number((plan.sectorOffset >> 32n) & 0xffff_ffffn)
  );
  publishWakeLevel({
    bytes: memory.bytes,
    index: virtioHostIndex(memory, VIRTIO_HOST_REQUEST_SEQ),
    level: (loadVirtioDiskRequestSeq(memory) + 1) >>> 0,
  });
};

/** Parse, plan, then either publish synchronously or submit to the disk worker. */
const processVirtioSlot = (
  memory: Memory,
  config: VirtioQueueConfig,
  head: number
): VirtioSlotResult => {
  const descriptors = readDescriptorChain(memory, config, head);
  if (descriptors === null) {
    return VIRTIO_SLOT_SKIP;
  }
  const statusDescriptor = trailingStatusDescriptor(descriptors);
  if (statusDescriptor === undefined) {
    return VIRTIO_SLOT_SKIP;
  }
  const plan = planBlockRequest(memory, descriptors);
  if (plan === null) {
    return VIRTIO_SLOT_SKIP;
  }
  if (plan.kind === 'sync') {
    const published = publishCompletedVirtioSlot(
      memory,
      config,
      head,
      statusDescriptor.address,
      plan.statusByte,
      plan.usedLen
    );
    return published ? VIRTIO_SLOT_PUBLISHED : VIRTIO_SLOT_SKIP;
  }
  if (plan.kind === 'write') {
    const stagingBase = virtioHostIndex(memory, VIRTIO_HOST_STAGING);
    const staging = memory.bytes.subarray(stagingBase, stagingBase + plan.dataLength);
    if (!stageGuestData(memory, plan.dataSegments, staging)) {
      // Guest buffers unreadable: complete synchronously, no file I/O.
      const published = publishCompletedVirtioSlot(
        memory,
        config,
        head,
        statusDescriptor.address,
        VIRTIO_BLK_S_IOERR,
        1
      );
      return published ? VIRTIO_SLOT_PUBLISHED : VIRTIO_SLOT_SKIP;
    }
  }
  submitVirtioRequest(memory, head, statusDescriptor.address, plan);
  return VIRTIO_SLOT_SUBMITTED;
};

/** Publish one completed request, update `drainedSeq`; true when a used entry landed. */
const drainCompletedVirtioRequest = (memory: Memory): boolean => {
  const completionSeq = loadVirtioDiskCompletionSeq(memory);
  const config = loadVirtioDiskQueueConfig(memory);
  if (config === null) {
    // Reset happened and gates fell — swallow without publishing.
    storeVirtioShadowU32(memory, VIRTIO_HOST_DRAINED_SEQ, completionSeq);
    return false;
  }
  const ioError = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_REQUEST_IO_ERROR), 0) >>> 0;
  const head = loadVirtioShadowU32(memory, VIRTIO_HOST_PENDING_HEAD);
  const statusAddress = virtioHostBigUint64(memory, VIRTIO_HOST_PENDING_STATUS_ADDRESS)[0] ?? 0n;
  const dataLength = loadVirtioShadowU32(memory, VIRTIO_HOST_PENDING_DATA_LENGTH);
  let usedLen = loadVirtioShadowU32(memory, VIRTIO_HOST_PENDING_USED_LEN);
  const direction = loadVirtioShadowU32(memory, VIRTIO_HOST_REQUEST_DIRECTION);
  let statusByte = ioError !== 0 ? VIRTIO_BLK_S_IOERR : VIRTIO_BLK_S_OK;
  if (ioError === 0 && direction === VIRTIO_BLK_T_IN) {
    const stagingBase = virtioHostIndex(memory, VIRTIO_HOST_STAGING);
    const staging = memory.bytes.subarray(stagingBase, stagingBase + dataLength);
    if (!storeStagingData(memory, pendingDataSegments, staging)) {
      statusByte = VIRTIO_BLK_S_IOERR;
      usedLen = 1;
    }
  }
  const published = publishCompletedVirtioSlot(
    memory,
    config,
    head,
    statusAddress,
    statusByte,
    usedLen
  );
  storeVirtioShadowU32(memory, VIRTIO_HOST_DRAINED_SEQ, completionSeq);
  return published;
};

/** Consume available slots while the channel is idle; true when anything was published. */
const advanceVirtioQueue = (
  memory: Memory,
  config: VirtioQueueConfig,
  availIdx: number
): boolean => {
  let publishedAny = false;
  for (;;) {
    if (loadVirtioDiskRequestSeq(memory) !== loadVirtioDiskCompletionSeq(memory)) {
      break; // I/O in flight
    }
    const lastAvail = loadVirtioShadowU32(memory, VIRTIO_HOST_LAST_AVAIL_IDX) & 0xffff;
    if (lastAvail === availIdx) {
      break; // queue drained
    }
    const slot = lastAvail % config.queueNum;
    const head = loadGuestU16(memory, config.driverBase + 4n + BigInt(slot * 2));
    const result = head === null ? VIRTIO_SLOT_SKIP : processVirtioSlot(memory, config, head);
    const next = (lastAvail + 1) & 0xffff;
    storeVirtioShadowU32(memory, VIRTIO_HOST_LAST_AVAIL_IDX, next);
    if (result === VIRTIO_SLOT_SUBMITTED) {
      break; // wait for the disk worker
    }
    if (result === VIRTIO_SLOT_PUBLISHED) {
      publishedAny = true;
    }
  }
  return publishedAny;
};

/**
 * Service pending disk work: drain a completed request and advance queue 0. Call per fetch,
 * on QueueNotify, and after the completion wake word resolves. Draining a completed request
 * into guest RAM is what raises the device's PLIC source (interrupt status plus wire), so a
 * completion only becomes guest-visible through this call.
 */
const serviceVirtioDiskQueue = (memory: Memory): void => {
  if (loadVirtioDevicePresent(memory) === 0) {
    return;
  }
  let publishedAny = false;
  // 1. Drain: a disk-worker completion awaits publication.
  if (
    loadVirtioDiskCompletionSeq(memory) !== loadVirtioShadowU32(memory, VIRTIO_HOST_DRAINED_SEQ)
  ) {
    publishedAny = drainCompletedVirtioRequest(memory);
  }
  // 2. Advance the queue while the channel is idle.
  const config = loadVirtioDiskQueueConfig(memory);
  if (config !== null) {
    const availIdx = loadGuestU16(memory, config.driverBase + 2n);
    if (availIdx !== null && advanceVirtioQueue(memory, config, availIdx)) {
      publishedAny = true;
    }
  }
  // 3. Interrupt assert is the last visible side effect.
  if (publishedAny) {
    const word = loadVirtioShadowU32(memory, VIRTIO_HOST_INTERRUPT_STATUS) | VIRTIO_MMIO_INT_VRING;
    storeVirtioShadowU32(memory, VIRTIO_HOST_INTERRUPT_STATUS, word >>> 0);
    setPlicSourcePending(memory, PLIC_SOURCE_VIRTIO, true);
  }
};

/** Park (waitAsync) until the disk worker publishes a new completion level. */
const waitVirtioDiskCompletion = async (
  memory: Memory,
  fromLevel: number,
  signal?: AbortSignal
): Promise<void> =>
  waitWake({
    bytes: memory.bytes,
    index: virtioHostIndex(memory, VIRTIO_HOST_COMPLETION_SEQ),
    fromLevel,
    signal,
  });

export { loadVirtioDiskCompletionSeq, serviceVirtioDiskQueue, waitVirtioDiskCompletion };
