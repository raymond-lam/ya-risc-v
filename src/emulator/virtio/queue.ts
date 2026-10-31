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
 * VirtIO block request execution — descriptor-chain validation, read completion,
 * used-ring publication, and interrupt notification.
 */

import { dmaLoad, dmaStore, resolveDmaSpan } from '#emulator/dma';
import type { Memory } from '#emulator/memory';
import { PLIC_SOURCE_VIRTIO, setPlicSourcePending } from '#emulator/plic';
import type { ReadonlyUint8Array } from '#types';
import {
  bytesToBigInt,
  bytesToNumber,
  unsignedBigIntToBytes,
  unsignedNumberToBytes,
} from '#utils/bytes';
import {
  guestAddressPlus,
  VIRTIO_INTERNAL_OFFSET,
  VIRTIO_REGISTER_OFFSET,
  virtioHostIndex,
} from '#emulator/virtio/region';

const VIRTIO_BLK_T_IN = 0;
const VIRTIO_BLK_S_OK = 0;
const VIRTIO_BLK_S_IOERR = 1;
const VIRTIO_BLK_S_UNSUPP = 2;

const VIRTQ_DESC_F_NEXT = 1;
const VIRTQ_DESC_F_WRITE = 2;

const QUEUE_NUM_MAX = 8;
const BLOCK_SIZE = 512n;

type Descriptor = {
  readonly address: ReadonlyUint8Array;
  readonly length: number;
  readonly flags: number;
  readonly next: number;
};

type RequestResult = {
  readonly status: number;
  readonly bytesWritten: number;
};

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

const loadHostUint16 = (memory: Memory, offset: number): number => {
  const base = virtioHostIndex(memory, offset);
  return ((memory.bytes[base] ?? 0) | ((memory.bytes[base + 1] ?? 0) << 8)) & 0xffff;
};

const storeHostUint16 = (memory: Memory, offset: number, value: number): void => {
  const base = virtioHostIndex(memory, offset);
  memory.bytes[base] = value & 0xff;
  memory.bytes[base + 1] = (value >>> 8) & 0xff;
};

const queueAddress = (memory: Memory, lowOffset: number, highOffset: number): bigint =>
  BigInt(loadHostUint32(memory, lowOffset)) | (BigInt(loadHostUint32(memory, highOffset)) << 32n);

const parseDescriptor = (bytes: Uint8Array): Descriptor => ({
  address: unsignedBigIntToBytes(new Uint8Array(8), bytesToBigInt(bytes.subarray(0, 8))),
  length: bytesToNumber(bytes.subarray(8, 12)),
  flags: bytesToNumber(bytes.subarray(12, 14)),
  next: bytesToNumber(bytes.subarray(14, 16)),
});

const loadDescriptor = (
  memory: Memory,
  descriptorTable: bigint,
  index: number
): Descriptor | null => {
  const bytes = new Uint8Array(16);
  const address = unsignedBigIntToBytes(new Uint8Array(8), descriptorTable + BigInt(index * 16));
  if (!dmaLoad(memory, address, bytes.length, bytes)) {
    return null;
  }
  return parseDescriptor(bytes);
};

const loadDescriptorChain = (
  memory: Memory,
  descriptorTable: bigint,
  head: number,
  queueNum: number
): Descriptor[] | null => {
  if (head < 0 || head >= queueNum) {
    return null;
  }
  const descriptors: Descriptor[] = [];
  const visited = new Set<number>();
  let index = head;
  for (;;) {
    if (visited.has(index) || descriptors.length >= queueNum) {
      return null;
    }
    visited.add(index);
    const descriptor = loadDescriptor(memory, descriptorTable, index);
    if (descriptor === null) {
      return null;
    }
    descriptors.push(descriptor);
    if ((descriptor.flags & VIRTQ_DESC_F_NEXT) === 0) {
      return descriptors;
    }
    if (descriptor.next >= queueNum) {
      return null;
    }
    index = descriptor.next;
  }
};

const descriptorChainShapeIsValid = (
  header: Descriptor,
  data: Descriptor,
  status: Descriptor
): boolean =>
  header.length >= 16 &&
  (header.flags & VIRTQ_DESC_F_WRITE) === 0 &&
  (header.flags & VIRTQ_DESC_F_NEXT) !== 0 &&
  (data.flags & VIRTQ_DESC_F_WRITE) !== 0 &&
  (data.flags & VIRTQ_DESC_F_NEXT) !== 0 &&
  (status.flags & VIRTQ_DESC_F_WRITE) !== 0 &&
  (status.flags & VIRTQ_DESC_F_NEXT) === 0 &&
  status.length === 1;

const executeRequest = (
  memory: Memory,
  image: ReadonlyUint8Array,
  header: Descriptor,
  data: Descriptor,
  status: Descriptor
): RequestResult => {
  const requestHeader = new Uint8Array(16);
  if (!dmaLoad(memory, header.address, requestHeader.length, requestHeader)) {
    return { status: VIRTIO_BLK_S_IOERR, bytesWritten: 0 };
  }
  const type = bytesToNumber(requestHeader.subarray(0, 4));
  if (type !== VIRTIO_BLK_T_IN) {
    return { status: VIRTIO_BLK_S_UNSUPP, bytesWritten: 0 };
  }
  if (
    resolveDmaSpan(memory, header.address, 16) === null ||
    resolveDmaSpan(memory, data.address, data.length) === null ||
    resolveDmaSpan(memory, status.address, status.length) === null
  ) {
    return { status: VIRTIO_BLK_S_IOERR, bytesWritten: 0 };
  }
  const sector = bytesToBigInt(requestHeader.subarray(8, 16));
  const start = sector * BLOCK_SIZE;
  const end = start + BigInt(data.length);
  if (end > BigInt(image.length)) {
    return { status: VIRTIO_BLK_S_IOERR, bytesWritten: 0 };
  }

  const startIndex = Number(start);
  const imageBytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    imageBytes[index] = image[startIndex + index] ?? 0;
  }
  if (!dmaStore(memory, data.address, data.length, imageBytes)) {
    return { status: VIRTIO_BLK_S_IOERR, bytesWritten: 0 };
  }
  return { status: VIRTIO_BLK_S_OK, bytesWritten: data.length };
};

const completeRequest = (
  memory: Memory,
  head: number,
  statusAddress: ReadonlyUint8Array,
  result: RequestResult,
  usedRing: bigint,
  queueNum: number
): boolean => {
  if (!dmaStore(memory, statusAddress, 1, Uint8Array.of(result.status))) {
    // A guest-owned status buffer that cannot be written leaves the request unconsumed.
    return false;
  }

  const usedIndexBytes = new Uint8Array(2);
  const usedIndexAddress = guestAddressPlus(
    unsignedBigIntToBytes(new Uint8Array(8), usedRing + 2n),
    0n
  );
  if (!dmaLoad(memory, usedIndexAddress, usedIndexBytes.length, usedIndexBytes)) {
    return false;
  }
  const usedIndex = (usedIndexBytes[0] ?? 0) | ((usedIndexBytes[1] ?? 0) << 8);
  const usedElementAddress = unsignedBigIntToBytes(
    new Uint8Array(8),
    usedRing + 4n + BigInt((usedIndex % queueNum) * 8)
  );
  const usedElement = new Uint8Array(8);
  usedElement.set(unsignedNumberToBytes(new Uint8Array(4), head), 0);
  usedElement.set(unsignedNumberToBytes(new Uint8Array(4), result.bytesWritten), 4);
  if (!dmaStore(memory, usedElementAddress, usedElement.length, usedElement)) {
    return false;
  }

  const nextUsedIndex = (usedIndex + 1) & 0xffff;
  const nextUsedIndexBytes = new Uint8Array(2);
  nextUsedIndexBytes[0] = nextUsedIndex & 0xff;
  nextUsedIndexBytes[1] = (nextUsedIndex >>> 8) & 0xff;
  if (!dmaStore(memory, usedIndexAddress, nextUsedIndexBytes.length, nextUsedIndexBytes)) {
    return false;
  }

  const statusIndex = virtioHostIndex(memory, VIRTIO_REGISTER_OFFSET.interruptStatus);
  Atomics.or(memory.bytes, statusIndex, 1);
  setPlicSourcePending(memory, PLIC_SOURCE_VIRTIO, true);
  return true;
};

const serviceRequest = (
  memory: Memory,
  image: ReadonlyUint8Array,
  head: number,
  descriptorTable: bigint,
  usedRing: bigint,
  queueNum: number
): boolean => {
  const descriptors = loadDescriptorChain(memory, descriptorTable, head, queueNum);
  if (descriptors === null) {
    return false;
  }

  const header = descriptors[0];
  const data = descriptors[1];
  const thirdDescriptor = descriptors[2];
  if (header === undefined || data === undefined || thirdDescriptor === undefined) {
    return false;
  }
  if (descriptors.length !== 3 || !descriptorChainShapeIsValid(header, data, thirdDescriptor)) {
    if ((thirdDescriptor.flags & VIRTQ_DESC_F_WRITE) === 0 || thirdDescriptor.length < 1) {
      return false;
    }
    return completeRequest(
      memory,
      head,
      thirdDescriptor.address,
      { status: VIRTIO_BLK_S_IOERR, bytesWritten: 0 },
      usedRing,
      queueNum
    );
  }

  const result = executeRequest(memory, image, header, data, thirdDescriptor);
  return completeRequest(memory, head, thirdDescriptor.address, result, usedRing, queueNum);
};

/** Service every request published to queue zero since the previous service call. */
const serviceAllPending = (memory: Memory, image: ReadonlyUint8Array): void => {
  const queueNum = loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.queueNum);
  const ready = loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.queueReady);
  const selected = loadHostUint32(memory, VIRTIO_REGISTER_OFFSET.queueSel);
  if (
    ready === 0 ||
    selected !== 0 ||
    queueNum === 0 ||
    queueNum > QUEUE_NUM_MAX ||
    (queueNum & (queueNum - 1)) !== 0
  ) {
    return;
  }

  const driverRing = queueAddress(
    memory,
    VIRTIO_REGISTER_OFFSET.queueDriverLow,
    VIRTIO_REGISTER_OFFSET.queueDriverHigh
  );
  const usedRing = queueAddress(
    memory,
    VIRTIO_REGISTER_OFFSET.queueDeviceLow,
    VIRTIO_REGISTER_OFFSET.queueDeviceHigh
  );
  const descriptorTable = queueAddress(
    memory,
    VIRTIO_REGISTER_OFFSET.queueDescLow,
    VIRTIO_REGISTER_OFFSET.queueDescHigh
  );

  const availIndexBytes = new Uint8Array(2);
  const availIndexAddress = guestAddressPlus(
    unsignedBigIntToBytes(new Uint8Array(8), driverRing + 2n),
    0n
  );
  if (!dmaLoad(memory, availIndexAddress, availIndexBytes.length, availIndexBytes)) {
    return;
  }
  const availIndex = (availIndexBytes[0] ?? 0) | ((availIndexBytes[1] ?? 0) << 8);
  const lastAvailIndex = loadHostUint16(memory, VIRTIO_INTERNAL_OFFSET.lastAvailIndex);
  const pendingCount = (availIndex - lastAvailIndex) & 0xffff;
  const count = Math.min(pendingCount, queueNum);
  let completed = 0;

  for (let index = 0; index < count; index += 1) {
    const slot = ((lastAvailIndex + index) & 0xffff) % queueNum;
    const headBytes = new Uint8Array(2);
    const headAddress = guestAddressPlus(
      unsignedBigIntToBytes(new Uint8Array(8), driverRing + 4n),
      BigInt(slot * 2)
    );
    if (!dmaLoad(memory, headAddress, headBytes.length, headBytes)) {
      break;
    }
    const head = (headBytes[0] ?? 0) | ((headBytes[1] ?? 0) << 8);
    if (!serviceRequest(memory, image, head, descriptorTable, usedRing, queueNum)) {
      break;
    }
    completed += 1;
  }
  storeHostUint16(
    memory,
    VIRTIO_INTERNAL_OFFSET.lastAvailIndex,
    (lastAvailIndex + completed) & 0xffff
  );
};

export default serviceAllPending;
