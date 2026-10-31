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

import { initializePlic } from '#emulator/plic';
import { createMemory, loadBytes, storeBytes, type Memory } from '#emulator/memory';
import { RESERVATION_REGION_ID } from '#emulator/reservation';
import {
  initializeVirtio,
  VIRTIO_GUEST_BYTE_LENGTH,
  VIRTIO_HOST_BYTE_LENGTH,
  VIRTIO_INTERNAL_OFFSET,
  VIRTIO_REGION_ID,
  virtioHostIndex,
} from '#emulator/virtio/region';
import { storeBytesToVirtio } from '#emulator/virtio/memory';
import serviceAllPending from '#emulator/virtio/queue';
import { machineRegionSpecs } from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes, unsignedNumberToBytes } from '#utils/bytes';

const guestAddress = (value: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), value) as ReadonlyUint8Array;

const DESCRIPTOR_TABLE = 0x100n;
const AVAILABLE_RING = 0x200n;
const USED_RING = 0x300n;
const REQUEST_HEADER = 0x400n;
const DATA_BUFFER = 0x500n;
const STATUS_BUFFER = 0x700n;

const createVirtioMemory = (): Memory => {
  const memory = createMemory(
    machineRegionSpecs({
      ramBaseAddress: guestAddress(0n),
      ramSize: 4096n,
      uartBaseAddress: guestAddress(0x1000_0000n),
      clintBaseAddress: guestAddress(0x0200_0000n),
      plicBaseAddress: guestAddress(0x0c00_0000n),
      sysconBaseAddress: guestAddress(0x0010_0000n),
      virtioBaseAddress: guestAddress(0x1000_1000n),
    })
  );
  initializePlic(memory);
  initializeVirtio(memory, 1024);
  return memory;
};

const writeGuest = (memory: Memory, address: bigint, bytes: Uint8Array): void => {
  storeBytes({
    memory,
    address: guestAddress(address),
    source: bytes,
    byteLength: bytes.length,
  });
};

const readGuest = (memory: Memory, address: bigint, byteLength: number): Uint8Array => {
  const destination = new Uint8Array(byteLength);
  loadBytes({
    memory,
    address: guestAddress(address),
    destination,
    byteLength,
  });
  return destination;
};

const readUint32 = (memory: Memory, address: bigint): number => {
  const bytes = readGuest(memory, address, 4);
  return (
    ((bytes[0] ?? 0) |
      ((bytes[1] ?? 0) << 8) |
      ((bytes[2] ?? 0) << 16) |
      ((bytes[3] ?? 0) << 24)) >>>
    0
  );
};

const writeDescriptor = (
  memory: Memory,
  index: number,
  address: bigint,
  length: number,
  flags: number,
  next: number
): void => {
  const descriptor = new Uint8Array(16);
  descriptor.set(unsignedBigIntToBytes(new Uint8Array(8), address), 0);
  descriptor.set(unsignedNumberToBytes(new Uint8Array(8), length), 8);
  descriptor.set(unsignedNumberToBytes(new Uint8Array(8), flags).subarray(0, 2), 12);
  descriptor.set(unsignedNumberToBytes(new Uint8Array(8), next).subarray(0, 2), 14);
  writeGuest(memory, DESCRIPTOR_TABLE + BigInt(index * 16), descriptor);
};

const writeRequest = (
  memory: Memory,
  type: number,
  sector: bigint,
  dataAddress = DATA_BUFFER
): void => {
  const header = new Uint8Array(16);
  header.set(unsignedNumberToBytes(new Uint8Array(8), type), 0);
  header.set(unsignedBigIntToBytes(new Uint8Array(8), sector), 8);
  writeGuest(memory, REQUEST_HEADER, header);

  writeDescriptor(memory, 0, REQUEST_HEADER, 16, 1, 1);
  writeDescriptor(memory, 1, dataAddress, 512, 3, 2);
  writeDescriptor(memory, 2, STATUS_BUFFER, 1, 2, 0);

  const available = new Uint8Array(8);
  available[2] = 1;
  available[4] = 0;
  writeGuest(memory, AVAILABLE_RING, available);
  writeGuest(memory, USED_RING, new Uint8Array(16));
};

const writeDescriptorChain = ({
  memory,
  headerIndex,
  dataIndex,
  statusIndex,
  headerAddress,
  dataAddress,
  statusAddress,
  type = 0,
  sector = 0n,
}: {
  memory: Memory;
  headerIndex: number;
  dataIndex: number;
  statusIndex: number;
  headerAddress: bigint;
  dataAddress: bigint;
  statusAddress: bigint;
  type?: number;
  sector?: bigint;
}): void => {
  const header = new Uint8Array(16);
  header.set(unsignedNumberToBytes(new Uint8Array(8), type), 0);
  header.set(unsignedBigIntToBytes(new Uint8Array(8), sector), 8);
  writeGuest(memory, headerAddress, header);
  writeDescriptor(memory, headerIndex, headerAddress, 16, 1, dataIndex);
  writeDescriptor(memory, dataIndex, dataAddress, 512, 3, statusIndex);
  writeDescriptor(memory, statusIndex, statusAddress, 1, 2, 0);
};

const writeAvailable = (
  memory: Memory,
  heads: readonly number[],
  availIndex = heads.length
): void => {
  const available = new Uint8Array(8);
  available[2] = availIndex & 0xff;
  available[3] = (availIndex >>> 8) & 0xff;
  for (let index = 0; index < heads.length; index += 1) {
    const head = heads[index] ?? 0;
    available[4 + index * 2] = head & 0xff;
    available[5 + index * 2] = (head >>> 8) & 0xff;
  }
  writeGuest(memory, AVAILABLE_RING, available);
};

const configureQueue = (memory: Memory): void => {
  const store32 = (offset: number, value: number): void => {
    const word = value >>> 0;
    storeBytesToVirtio({
      memory,
      address: guestAddress(0n),
      offset: BigInt(offset),
      source: Uint8Array.of(
        word & 0xff,
        (word >>> 8) & 0xff,
        (word >>> 16) & 0xff,
        (word >>> 24) & 0xff
      ),
      byteLength: 4,
    });
  };
  store32(0x038, 8);
  store32(0x080, Number(DESCRIPTOR_TABLE));
  store32(0x084, 0);
  store32(0x090, Number(AVAILABLE_RING));
  store32(0x094, 0);
  store32(0x0a0, Number(USED_RING));
  store32(0x0a4, 0);
  store32(0x044, 1);
};

const createImage = (): Uint8Array => {
  const image = new Uint8Array(1024);
  for (let index = 0; index < image.length; index += 1) {
    image[index] = index & 0xff;
  }
  return image;
};

const assertCompletion = (memory: Memory, expectedStatus: number, expectedLength: number): void => {
  assert.equal(readGuest(memory, STATUS_BUFFER, 1)[0], expectedStatus);
  const usedElement = readGuest(memory, USED_RING + 4n, 8);
  assert.equal(
    (usedElement[0] ?? 0) |
      ((usedElement[1] ?? 0) << 8) |
      ((usedElement[2] ?? 0) << 16) |
      ((usedElement[3] ?? 0) << 24),
    0
  );
  assert.equal(
    (usedElement[4] ?? 0) |
      ((usedElement[5] ?? 0) << 8) |
      ((usedElement[6] ?? 0) << 16) |
      ((usedElement[7] ?? 0) << 24),
    expectedLength
  );
  const usedIndex = readGuest(memory, USED_RING + 2n, 2);
  assert.equal((usedIndex[0] ?? 0) | ((usedIndex[1] ?? 0) << 8), 1);
};

describe('VirtIO block request queue', () => {
  it('follows a non-sequential descriptor chain from the avail head', () => {
    const memory = createVirtioMemory();
    const image = createImage();
    writeDescriptorChain({
      memory,
      headerIndex: 5,
      dataIndex: 3,
      statusIndex: 7,
      headerAddress: REQUEST_HEADER,
      dataAddress: DATA_BUFFER,
      statusAddress: STATUS_BUFFER,
    });
    writeAvailable(memory, [5]);
    configureQueue(memory);

    serviceAllPending(memory, image);

    assert.deepEqual(readGuest(memory, DATA_BUFFER, 512), image.subarray(0, 512));
    assert.equal(readGuest(memory, STATUS_BUFFER, 1)[0], 0);
    assert.equal(readUint32(memory, USED_RING + 4n), 5);
  });

  it('processes avail.ring[0] before ring[1]', () => {
    const memory = createVirtioMemory();
    const image = createImage();
    writeDescriptorChain({
      memory,
      headerIndex: 5,
      dataIndex: 3,
      statusIndex: 7,
      headerAddress: REQUEST_HEADER,
      dataAddress: DATA_BUFFER,
      statusAddress: STATUS_BUFFER,
    });
    writeDescriptorChain({
      memory,
      headerIndex: 1,
      dataIndex: 4,
      statusIndex: 2,
      headerAddress: 0x440n,
      dataAddress: 0x540n,
      statusAddress: 0x740n,
    });
    writeAvailable(memory, [5, 1]);
    configureQueue(memory);

    serviceAllPending(memory, image);

    assert.equal(readUint32(memory, USED_RING + 4n), 5);
    assert.equal(readUint32(memory, USED_RING + 12n), 1);
    const usedIndex = readGuest(memory, USED_RING + 2n, 2);
    assert.equal((usedIndex[0] ?? 0) | ((usedIndex[1] ?? 0) << 8), 2);
  });

  it('drains at most queueNum entries and advances only by completed entries', () => {
    const memory = createVirtioMemory();
    writeRequest(memory, 0, 0n);
    writeAvailable(memory, [0, 0, 0, 0, 0, 0, 0, 0], 20);
    configureQueue(memory);

    serviceAllPending(memory, createImage());

    const usedIndex = readGuest(memory, USED_RING + 2n, 2);
    assert.equal((usedIndex[0] ?? 0) | ((usedIndex[1] ?? 0) << 8), 8);
    const lastAvailIndex = virtioHostIndex(memory, VIRTIO_INTERNAL_OFFSET.lastAvailIndex);
    assert.equal(
      (memory.bytes[lastAvailIndex] ?? 0) | ((memory.bytes[lastAvailIndex + 1] ?? 0) << 8),
      8
    );
  });

  it('does not consume a request whose descriptor chain cannot be read', () => {
    const memory = createVirtioMemory();
    writeRequest(memory, 0, 0n);
    writeDescriptor(memory, 0, REQUEST_HEADER, 16, 1, 8);
    configureQueue(memory);

    serviceAllPending(memory, createImage());

    const usedIndex = readGuest(memory, USED_RING + 2n, 2);
    assert.equal((usedIndex[0] ?? 0) | ((usedIndex[1] ?? 0) << 8), 0);
    const lastAvailIndex = virtioHostIndex(memory, VIRTIO_INTERNAL_OFFSET.lastAvailIndex);
    assert.equal(
      (memory.bytes[lastAvailIndex] ?? 0) | ((memory.bytes[lastAvailIndex + 1] ?? 0) << 8),
      0
    );
  });

  it('completes a readable malformed chain with IOERR through its third descriptor', () => {
    const memory = createVirtioMemory();
    writeDescriptorChain({
      memory,
      headerIndex: 5,
      dataIndex: 3,
      statusIndex: 7,
      headerAddress: REQUEST_HEADER,
      dataAddress: DATA_BUFFER,
      statusAddress: STATUS_BUFFER,
    });
    writeDescriptor(memory, 3, DATA_BUFFER, 512, 1, 7);
    writeAvailable(memory, [5]);
    configureQueue(memory);

    serviceAllPending(memory, createImage());

    assert.equal(readGuest(memory, STATUS_BUFFER, 1)[0], 1);
    assert.equal(readUint32(memory, USED_RING + 4n), 5);
    assert.equal(readUint32(memory, USED_RING + 8n), 0);
  });

  it('completes a read with data, status, used element, interrupt, and PLIC pending', () => {
    const memory = createVirtioMemory();
    const image = createImage();
    writeRequest(memory, 0, 0n);
    configureQueue(memory);

    serviceAllPending(memory, image);

    assert.deepEqual(readGuest(memory, DATA_BUFFER, 512), image.subarray(0, 512));
    assertCompletion(memory, 0, 512);

    const interruptStatus = readGuest(memory, 0x1000_1060n, 4);
    assert.equal(interruptStatus[0] ?? 0, 1);
    const plicPending = readGuest(memory, 0x0c00_1000n, 4);
    assert.equal((plicPending[0] ?? 0) & 0x02, 0x02);
  });

  it('completes an out-of-bounds sector as IOERR', () => {
    const memory = createVirtioMemory();
    writeRequest(memory, 0, 2n);
    configureQueue(memory);

    serviceAllPending(memory, createImage());

    assertCompletion(memory, 1, 0);
  });

  it('completes an unsupported request type as UNSUPP', () => {
    const memory = createVirtioMemory();
    writeRequest(memory, 1, 0n);
    configureQueue(memory);

    serviceAllPending(memory, createImage());

    assertCompletion(memory, 2, 0);
  });

  it('completes an unmapped data descriptor as IOERR without a host failure', () => {
    const memory = createVirtioMemory();
    writeRequest(memory, 0, 0n, 0x8000_0000n);
    configureQueue(memory);

    serviceAllPending(memory, createImage());

    assertCompletion(memory, 1, 0);
  });
});
