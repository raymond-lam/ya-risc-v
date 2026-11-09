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
 * Guest-side virtio-blk fixtures: MMIO register access, descriptor chains, queue
 * configuration, and the PLIC/reservation helpers. Shared by the queue engine tests
 * (`queue.test.ts`, no device worker) and the device-loop tests
 * (`queue.device.test.ts`, real disk worker).
 */

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { loadBytes, storeBytes, type Memory } from '#emulator/memory';
import {
  RESERVATION_REGION_ID,
  reservationLockIndex,
  setReservationLocked,
} from '#emulator/reservation';
import {
  VIRTIO_HOST_QUEUE_EPOCH,
  VRING_DESC_F_NEXT,
  VRING_DESC_F_WRITE,
} from '#emulator/virtio/layout';
import { loadVirtioDiskCapacity, loadVirtioShadowU32 } from '#emulator/virtio/registers';
import { claimVirtioRequest, completeVirtioRequest } from '#emulator/virtio/queue';
import { plicGatewayLockIndex } from '#emulator/plic';
import withSharedLocks from '#emulator/with-shared-locks';
import type { ReadonlyUint8Array } from '#types';
import { bytesToNumber, unsignedBigIntToBytes, unsignedNumberToBytes } from '#utils/bytes';
import { bigIntAsNumber } from '#utils/int';

const VIRTIO_BASE = 0x1000_1000n;
const PLIC_BASE = 0x0c00_0000n;
// PLIC_SOURCE_VIRTIO (= 1) is provided by WP2's plic/layout.ts (spec §17).
const PLIC_SOURCE_VIRTIO = 1;
const DESC_BASE = 0x000n;
const AVAIL_BASE = 0x080n;
const USED_BASE = 0x0a0n;
const HEADER1 = 0x100n;
const DATA1 = 0x110n;
const DATA2 = 0x120n;
const DATA3 = 0x130n;
const STATUS1 = 0x150n;
const HEADER2 = 0x160n;
const STATUS2 = 0x170n;

const SECTOR_HEAD = new Uint8Array([
  0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed, 0xfe, 0x0f,
]);
const guest = (address: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), address) as ReadonlyUint8Array;

const virtioAddress = (offset: bigint): ReadonlyUint8Array => guest(VIRTIO_BASE + offset);

const storeGuest = async (memory: Memory, address: bigint, bytes: Uint8Array): Promise<void> => {
  await storeBytes({ memory, address: guest(address), source: bytes, byteLength: bytes.length });
};

const loadGuest = async (
  memory: Memory,
  address: bigint,
  byteLength: number
): Promise<Uint8Array> => {
  const destination = new Uint8Array(byteLength);
  await loadBytes({ destination, memory, address: guest(address), byteLength });
  return destination;
};

const writeU16 = async (memory: Memory, address: bigint, value: number): Promise<void> => {
  await storeGuest(memory, address, unsignedNumberToBytes(new Uint8Array(2), value));
};

const readU16 = async (memory: Memory, address: bigint): Promise<number> => {
  const word = await loadGuest(memory, address, 2);
  return (word[0] ?? 0) | ((word[1] ?? 0) << 8);
};

const readU32 = async (memory: Memory, address: bigint): Promise<number> =>
  bytesToNumber(await loadGuest(memory, address, 4));
const readVirtioRegister = async (memory: Memory, offset: bigint): Promise<number> => {
  const destination = new Uint8Array(4);
  await loadBytes({ destination, memory, address: virtioAddress(offset), byteLength: 4 });
  return bytesToNumber(destination);
};

const writeVirtioRegister = async (
  memory: Memory,
  offset: bigint,
  value: number
): Promise<void> => {
  await storeBytes({
    memory,
    address: virtioAddress(offset),
    source: unsignedNumberToBytes(new Uint8Array(8), value),
    byteLength: 4,
  });
};

const armPlicVirtio = async (memory: Memory): Promise<void> => {
  const store = async (offset: bigint, value: number): Promise<void> => {
    await storeBytes({
      memory,
      address: guest(PLIC_BASE + offset),
      source: unsignedNumberToBytes(new Uint8Array(8), value),
      byteLength: 4,
    });
  };
  await store(BigInt(PLIC_SOURCE_VIRTIO * 4), 1); // priority
  await store(0x2000n, 1 << PLIC_SOURCE_VIRTIO); // enable M
  await store(0x200000n, 0); // threshold
};
const writeDescriptor = async (
  memory: Memory,
  index: number,
  descriptor: { address: bigint; length: number; flags: number; next: number }
): Promise<void> => {
  const raw = new Uint8Array(16);
  raw.set(unsignedBigIntToBytes(new Uint8Array(8), descriptor.address), 0);
  raw.set(unsignedNumberToBytes(new Uint8Array(4), descriptor.length), 8);
  raw[12] = descriptor.flags & 0xff;
  raw[13] = (descriptor.flags >>> 8) & 0xff;
  raw[14] = descriptor.next & 0xff;
  raw[15] = (descriptor.next >>> 8) & 0xff;
  await storeGuest(memory, DESC_BASE + 16n * BigInt(index), raw);
};

type ChainSpec = {
  head: number;
  dataSlot: number;
  statusSlot: number;
  headerAddress: bigint;
  dataAddress: bigint;
  statusAddress: bigint;
  dataLength: number;
  type: number;
  sector: bigint;
  /** Data descriptor WRITE flag: true for IN, false for OUT. Defaults to IN. */
  dataWritable?: boolean;
};

/** Queue one canonical 3-descriptor chain (header → data → status). */
const queueChain = async (memory: Memory, spec: ChainSpec): Promise<void> => {
  const dataFlags =
    spec.dataWritable === false ? VRING_DESC_F_NEXT : VRING_DESC_F_WRITE | VRING_DESC_F_NEXT;
  await writeDescriptor(memory, spec.head, {
    address: spec.headerAddress,
    length: 16,
    flags: VRING_DESC_F_NEXT,
    next: spec.dataSlot,
  });
  await writeDescriptor(memory, spec.dataSlot, {
    address: spec.dataAddress,
    length: spec.dataLength,
    flags: dataFlags,
    next: spec.statusSlot,
  });
  await writeDescriptor(memory, spec.statusSlot, {
    address: spec.statusAddress,
    length: 1,
    flags: VRING_DESC_F_WRITE,
    next: 0,
  });
  const header = new Uint8Array(16);
  header.set(unsignedNumberToBytes(new Uint8Array(4), spec.type), 0);
  header.set(unsignedBigIntToBytes(new Uint8Array(8), spec.sector), 8);
  await storeGuest(memory, spec.headerAddress, header);
};
/** Write a virtio-blk request header at HEADER1 (independent of the descriptor chain). */
const writeBlockHeader = async (memory: Memory, type: number, sector: bigint): Promise<void> => {
  const header = new Uint8Array(16);
  header.set(unsignedNumberToBytes(new Uint8Array(4), type), 0);
  header.set(unsignedBigIntToBytes(new Uint8Array(8), sector), 8);
  await storeGuest(memory, HEADER1, header);
};

const configureQueue = async (memory: Memory): Promise<void> => {
  await writeVirtioRegister(memory, 0x070n, 0); // reset
  await writeVirtioRegister(memory, 0x070n, 1); // ACKNOWLEDGE
  await writeVirtioRegister(memory, 0x070n, 3); // + DRIVER
  await writeVirtioRegister(memory, 0x014n, 0); // DeviceFeaturesSel 0
  await writeVirtioRegister(memory, 0x024n, 0); // DriverFeaturesSel 0
  await writeVirtioRegister(memory, 0x020n, 0); // DriverFeatures 0
  await writeVirtioRegister(memory, 0x070n, 0xb); // + FEATURES_OK
  assert.equal((await readVirtioRegister(memory, 0x070n)) & 0x08, 0x08);
  await writeVirtioRegister(memory, 0x070n, 0xf); // + DRIVER_OK
  await writeVirtioRegister(memory, 0x030n, 0); // QueueSel 0
  await writeVirtioRegister(memory, 0x038n, 8); // QueueNum 8
  await writeVirtioRegister(memory, 0x080n, 0x000); // QueueDescLow
  await writeVirtioRegister(memory, 0x084n, 0);
  await writeVirtioRegister(memory, 0x090n, 0x080); // QueueDriverLow
  await writeVirtioRegister(memory, 0x094n, 0);
  await writeVirtioRegister(memory, 0x0a0n, 0x0a0); // QueueDeviceLow
  await writeVirtioRegister(memory, 0x0a4n, 0);
  await writeVirtioRegister(memory, 0x044n, 1); // QueueReady
  await armPlicVirtio(memory);
};
/** Arm a reservation under the monitor lock (mirrors production LR path). */
const setReservation = async (
  memory: Memory,
  hartId: number,
  address: ReadonlyUint8Array,
  byteLength: number
): Promise<void> => {
  await withSharedLocks(memory.bytes, [reservationLockIndex(memory)], () => {
    setReservationLocked(memory, hartId, address, byteLength);
  });
};

/** Observe whether hart `hartId`'s slot is valid (test-only). */
const slotValid = (memory: Memory, hartId: number): boolean => {
  const region = memory.regions.get(RESERVATION_REGION_ID);
  assert.ok(region);
  const slotBase = bigIntAsNumber(region.hostIndex) + 8 + hartId * 16;
  return Atomics.load(new Int32Array(memory.bytes.buffer, slotBase, 1), 0) !== 0;
};
const waitUntil = async (predicate: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 1000; i++) {
    if (await predicate()) return;
    await delay(1);
  }
  assert.fail('queue did not complete');
};

const usedIdx = (memory: Memory): Promise<number> => readU16(memory, USED_BASE + 2n);

/** Wait for a queue predicate, failing the test after the bounded poll window. */
const waitForQueue = async (memory: Memory, predicate: () => Promise<boolean>): Promise<void> => {
  await waitUntil(predicate);
};

const unitStates = new WeakMap<Memory, { epoch: number; lastAvail: number; kicked: boolean }>();
const pumpUnitQueue = async (memory: Memory): Promise<void> => {
  if (loadVirtioDiskCapacity(memory) !== 0n) return; // real worker owns active file-backed queues
  let state = unitStates.get(memory);
  if (state === undefined) {
    state = {
      epoch: loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_EPOCH),
      lastAvail: 0,
      kicked: true,
    };
    unitStates.set(memory, state);
  }
  const queueState = state;
  await withSharedLocks(
    memory.bytes,
    [reservationLockIndex(memory), plicGatewayLockIndex(memory)],
    () => {
      queueState.kicked = true;
      for (let i = 0; i < 8; i++) {
        const request = claimVirtioRequest(memory, queueState);
        if (request !== null) completeVirtioRequest(memory, request, false);
      }
    }
  );
};

export {
  AVAIL_BASE,
  DATA1,
  DATA2,
  DATA3,
  DESC_BASE,
  HEADER1,
  HEADER2,
  PLIC_BASE,
  PLIC_SOURCE_VIRTIO,
  SECTOR_HEAD,
  STATUS1,
  STATUS2,
  USED_BASE,
  VIRTIO_BASE,
  armPlicVirtio,
  configureQueue,
  guest,
  loadGuest,
  queueChain,
  pumpUnitQueue,
  readU16,
  readU32,
  readVirtioRegister,
  setReservation,
  slotValid,
  storeGuest,
  usedIdx,
  virtioAddress,
  waitForQueue,
  waitUntil,
  writeBlockHeader,
  writeDescriptor,
  writeU16,
  writeVirtioRegister,
};
export type { ChainSpec };
