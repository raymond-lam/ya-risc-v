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

import { initializePlic, PLIC_SOURCE_VIRTIO, setPlicSourcePending } from '#emulator/plic';
import { createMemory, loadBytes, type Memory } from '#emulator/memory';
import {
  initializeVirtio,
  VIRTIO_GUEST_BYTE_LENGTH,
  VIRTIO_HOST_BYTE_LENGTH,
  VIRTIO_REGION_ID,
  VIRTIO_REGISTER_OFFSET,
  virtioHostIndex,
} from '#emulator/virtio/region';
import { loadBytesFromVirtio, storeBytesToVirtio } from '#emulator/virtio/memory';
import { RESERVATION_REGION_ID } from '#emulator/reservation';
import { machineRegionSpecs } from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { unsignedBigIntToBytes } from '#utils/bytes';

const guestAddress = (value: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), value) as ReadonlyUint8Array;

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

const load32 = (memory: Memory, offset: number): number => {
  const destination = new Uint8Array(4);
  loadBytesFromVirtio({
    destination,
    memory,
    address: guestAddress(0n),
    offset: BigInt(offset),
    byteLength: 4,
  });
  return (
    ((destination[0] ?? 0) |
      ((destination[1] ?? 0) << 8) |
      ((destination[2] ?? 0) << 16) |
      ((destination[3] ?? 0) << 24)) >>>
    0
  );
};

const store32 = (memory: Memory, offset: number, value: number): void => {
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

const load64 = (memory: Memory, offset: number): bigint => {
  const destination = new Uint8Array(8);
  loadBytesFromVirtio({
    destination,
    memory,
    address: guestAddress(0n),
    offset: BigInt(offset),
    byteLength: 8,
  });
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(destination[index] ?? 0);
  }
  return value;
};

const loadByte = (memory: Memory, offset: number): number => {
  const destination = new Uint8Array(1);
  loadBytesFromVirtio({
    destination,
    memory,
    address: guestAddress(0n),
    offset: BigInt(offset),
    byteLength: 1,
  });
  return destination[0] ?? 0;
};

describe('VirtIO-MMIO registers', () => {
  it('pins the modern v2 probe identities and configuration space', () => {
    const memory = createVirtioMemory();

    assert.equal(load32(memory, 0x000), 0x7472_6976);
    assert.equal(load32(memory, 0x004), 2);
    assert.equal(load32(memory, 0x008), 2);
    assert.equal(load32(memory, 0x00c), 0x554d_4551);
    assert.equal(load32(memory, 0x034), 8);
    assert.equal(load64(memory, 0x100), 2n);
    assert.equal(load32(memory, 0x108), 0);
    assert.equal(load32(memory, 0x10c), 8);
    assert.equal(load32(memory, 0x114), 512);
  });

  it('pages device features and preserves FEATURES_OK for accepted features', () => {
    const memory = createVirtioMemory();

    store32(memory, 0x014, 0);
    assert.equal(load32(memory, 0x010), 0);
    store32(memory, 0x014, 1);
    assert.equal(load32(memory, 0x010), 1);

    store32(memory, 0x024, 1);
    store32(memory, 0x020, 1);
    store32(memory, 0x070, 0x0b);
    assert.equal(loadByte(memory, 0x070), 0x0b);

    store32(memory, 0x020, 2);
    assert.equal(loadByte(memory, 0x070), 0x03);
  });

  it('accepts only power-of-two queue sizes and gates QueueReady on full geometry', () => {
    const memory = createVirtioMemory();

    store32(memory, 0x038, 3);
    store32(memory, 0x044, 1);
    assert.equal(loadByte(memory, 0x044), 0);

    store32(memory, 0x038, 8);
    store32(memory, 0x080, 0x100);
    store32(memory, 0x084, 0);
    store32(memory, 0x090, 0x200);
    store32(memory, 0x094, 0);
    store32(memory, 0x0a0, 0x300);
    store32(memory, 0x0a4, 0);
    assert.equal(loadByte(memory, 0x044), 0);

    store32(memory, 0x044, 1);
    assert.equal(loadByte(memory, 0x044), 1);
  });

  it('reads reserved holes as zero', () => {
    const memory = createVirtioMemory();

    assert.equal(load32(memory, 0x040), 0);
    assert.equal(load32(memory, 0x048), 0);
    assert.equal(load32(memory, 0x058), 0);
  });

  it('clears only acknowledged interrupt bits and deasserts PLIC source 1', () => {
    const memory = createVirtioMemory();
    Atomics.or(memory.bytes, virtioHostIndex(memory, VIRTIO_REGISTER_OFFSET.interruptStatus), 1);
    setPlicSourcePending(memory, PLIC_SOURCE_VIRTIO, true);

    const plicPending = new Uint8Array(4);
    loadBytes({
      memory,
      address: guestAddress(0x0c00_1000n),
      destination: plicPending,
      byteLength: 4,
    });
    assert.equal((plicPending[0] ?? 0) & 0x02, 0x02);

    store32(memory, 0x064, 1);
    assert.equal(load32(memory, 0x060), 0);
    loadBytes({
      memory,
      address: guestAddress(0x0c00_1000n),
      destination: plicPending,
      byteLength: 4,
    });
    assert.equal((plicPending[0] ?? 0) & 0x02, 0);
  });
});
