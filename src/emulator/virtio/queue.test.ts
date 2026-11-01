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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadBytes, storeBytes, type Memory } from '#emulator/memory';
import { isPlicMachineExternalPending } from '#emulator/plic';
import {
  RESERVATION_REGION_ID,
  setReservationLocked,
  withMonitorLock,
} from '#emulator/reservation';
import { create as createVirtioDisk, type VirtioDiskHandle } from '#emulator/virtio/host';
import {
  VIRTIO_HOST_REQUEST_SEQ,
  VRING_DESC_F_NEXT,
  VRING_DESC_F_WRITE,
  loadVirtioDiskCapacity,
  loadVirtioShadowU32,
} from '#emulator/virtio/layout';
import {
  loadVirtioDiskCompletionSeq,
  pollVirtioDiskCompletions,
  waitVirtioDiskCompletion,
} from '#emulator/virtio/queue';
import type { ReadonlyUint8Array } from '#types';
import { bytesToNumber, unsignedBigIntToBytes, unsignedNumberToBytes } from '#utils/bytes';
import { bigIntAsNumber } from '#utils/int';
import createTestMemory from '#test/guest-memory';

const VIRTIO_BASE = 0x1000_1000n;
const PLIC_BASE = 0x0c00_0000n;
// PLIC_SOURCE_VIRTIO (= 1) is provided by WP2's plic/layout.ts (spec §17).
const PLIC_SOURCE_VIRTIO = 1;
const TEMP_PREFIX = 'ya-risc-v-virtio-';

const DESC_BASE = 0x000n;
const AVAIL_BASE = 0x080n;
const USED_BASE = 0x0a0n;
const HEADER1 = 0x100n;
const DATA1 = 0x110n;
const DATA2 = 0x120n;
const STATUS1 = 0x150n;
const HEADER2 = 0x160n;
const STATUS2 = 0x170n;

const SECTOR_HEAD = new Uint8Array([
  0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed, 0xfe, 0x0f,
]);

const guest = (address: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), address) as ReadonlyUint8Array;

const virtioAddress = (offset: bigint): ReadonlyUint8Array => guest(VIRTIO_BASE + offset);

const storeGuest = (memory: Memory, address: bigint, bytes: Uint8Array): void => {
  storeBytes({ memory, address: guest(address), source: bytes, byteLength: bytes.length });
};

const loadGuest = (memory: Memory, address: bigint, byteLength: number): Uint8Array => {
  const destination = new Uint8Array(byteLength);
  loadBytes({ destination, memory, address: guest(address), byteLength });
  return destination;
};

const writeU16 = (memory: Memory, address: bigint, value: number): void => {
  storeGuest(memory, address, unsignedNumberToBytes(new Uint8Array(2), value));
};

const readU16 = (memory: Memory, address: bigint): number => {
  const word = loadGuest(memory, address, 2);
  return (word[0] ?? 0) | ((word[1] ?? 0) << 8);
};

const readU32 = (memory: Memory, address: bigint): number =>
  bytesToNumber(loadGuest(memory, address, 4));

const readVirtioRegister = (memory: Memory, offset: bigint): number => {
  const destination = new Uint8Array(4);
  loadBytes({ destination, memory, address: virtioAddress(offset), byteLength: 4 });
  return bytesToNumber(destination);
};

const writeVirtioRegister = (memory: Memory, offset: bigint, value: number): void => {
  storeBytes({
    memory,
    address: virtioAddress(offset),
    source: unsignedNumberToBytes(new Uint8Array(8), value),
    byteLength: 4,
  });
};

const armPlicVirtio = (memory: Memory): void => {
  const store = (offset: bigint, value: number): void => {
    storeBytes({
      memory,
      address: guest(PLIC_BASE + offset),
      source: unsignedNumberToBytes(new Uint8Array(8), value),
      byteLength: 4,
    });
  };
  store(BigInt(PLIC_SOURCE_VIRTIO * 4), 1); // priority
  store(0x2000n, 1 << PLIC_SOURCE_VIRTIO); // enable M
  store(0x200000n, 0); // threshold
};

const writeDescriptor = (
  memory: Memory,
  index: number,
  descriptor: { address: bigint; length: number; flags: number; next: number }
): void => {
  const raw = new Uint8Array(16);
  raw.set(unsignedBigIntToBytes(new Uint8Array(8), descriptor.address), 0);
  raw.set(unsignedNumberToBytes(new Uint8Array(4), descriptor.length), 8);
  raw[12] = descriptor.flags & 0xff;
  raw[13] = (descriptor.flags >>> 8) & 0xff;
  raw[14] = descriptor.next & 0xff;
  raw[15] = (descriptor.next >>> 8) & 0xff;
  storeGuest(memory, DESC_BASE + 16n * BigInt(index), raw);
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
const queueChain = (memory: Memory, spec: ChainSpec): void => {
  const dataFlags =
    spec.dataWritable === false ? VRING_DESC_F_NEXT : VRING_DESC_F_WRITE | VRING_DESC_F_NEXT;
  writeDescriptor(memory, spec.head, {
    address: spec.headerAddress,
    length: 16,
    flags: VRING_DESC_F_NEXT,
    next: spec.dataSlot,
  });
  writeDescriptor(memory, spec.dataSlot, {
    address: spec.dataAddress,
    length: spec.dataLength,
    flags: dataFlags,
    next: spec.statusSlot,
  });
  writeDescriptor(memory, spec.statusSlot, {
    address: spec.statusAddress,
    length: 1,
    flags: VRING_DESC_F_WRITE,
    next: 0,
  });
  const header = new Uint8Array(16);
  header.set(unsignedNumberToBytes(new Uint8Array(4), spec.type), 0);
  header.set(unsignedBigIntToBytes(new Uint8Array(8), spec.sector), 8);
  storeGuest(memory, spec.headerAddress, header);
};

const configureQueue = (memory: Memory): void => {
  writeVirtioRegister(memory, 0x070n, 0); // reset
  writeVirtioRegister(memory, 0x070n, 1); // ACKNOWLEDGE
  writeVirtioRegister(memory, 0x070n, 3); // + DRIVER
  writeVirtioRegister(memory, 0x014n, 0); // DeviceFeaturesSel 0
  writeVirtioRegister(memory, 0x024n, 0); // DriverFeaturesSel 0
  writeVirtioRegister(memory, 0x020n, 0); // DriverFeatures 0
  writeVirtioRegister(memory, 0x070n, 0xb); // + FEATURES_OK
  assert.equal(readVirtioRegister(memory, 0x070n) & 0x08, 0x08);
  writeVirtioRegister(memory, 0x070n, 0xf); // + DRIVER_OK
  writeVirtioRegister(memory, 0x030n, 0); // QueueSel 0
  writeVirtioRegister(memory, 0x038n, 8); // QueueNum 8
  writeVirtioRegister(memory, 0x080n, 0x000); // QueueDescLow
  writeVirtioRegister(memory, 0x084n, 0);
  writeVirtioRegister(memory, 0x090n, 0x080); // QueueDriverLow
  writeVirtioRegister(memory, 0x094n, 0);
  writeVirtioRegister(memory, 0x0a0n, 0x0a0); // QueueDeviceLow
  writeVirtioRegister(memory, 0x0a4n, 0);
  writeVirtioRegister(memory, 0x044n, 1); // QueueReady
  armPlicVirtio(memory);
};

/** Arm a reservation under the monitor lock (mirrors production LR path). */
const setReservation = (
  memory: Memory,
  hartId: number,
  address: ReadonlyUint8Array,
  byteLength: number
): void => {
  withMonitorLock(memory, () => {
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

/** File contents as a plain Uint8Array (readFileSync returns a Buffer). */
const readFileBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

const buildDiskImage = (): Uint8Array => {
  const image = new Uint8Array(4096);
  for (let sector = 0; sector < 8; sector += 1) {
    image.set(SECTOR_HEAD, sector * 512);
  }
  return image;
};

const writeTempDiskImage = (bytes: Uint8Array): { dir: string; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const path = join(dir, 'disk.img');
  writeFileSync(path, bytes);
  return { dir, path };
};

/** Bounded poll until the worker publishes its capacity. */
const awaitDiskCapacity = async (memory: Memory): Promise<void> => {
  for (let attempt = 0; attempt < 1000 && loadVirtioDiskCapacity(memory) === 0n; attempt += 1) {
    await delay(1);
  }
};

/** Bounded poll-and-drain until `predicate` holds (final drain included). */
const pollVirtioUntil = async (memory: Memory, predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 1000 && !predicate(); attempt += 1) {
    pollVirtioDiskCompletions(memory);
    await delay(1);
  }
  pollVirtioDiskCompletions(memory);
};

/** Run `body` against a real disk worker with a fresh temp image. */
const withDiskWorker = async (
  memory: Memory,
  body: (diskImagePath: string) => Promise<void> | void
): Promise<void> => {
  const { dir, path } = writeTempDiskImage(buildDiskImage());
  const disk: VirtioDiskHandle = createVirtioDisk({ memory, diskImagePath: path });
  disk.start();
  try {
    await awaitDiskCapacity(memory);
    await body(path);
  } finally {
    disk.stop();
    await disk;
    rmSync(dir, { recursive: true, force: true });
  }
};

const usedIdx = (memory: Memory): number => readU16(memory, USED_BASE + 2n);

describe('virtio queue engine', () => {
  it('IN request completes asynchronously: nothing publishes without a drain', async () => {
    const memory = createTestMemory(512n);
    configureQueue(memory);
    await withDiskWorker(memory, async () => {
      storeGuest(memory, DATA1, new Uint8Array(16).fill(0xee));
      storeGuest(memory, STATUS1, new Uint8Array([0xff]));
      setReservation(memory, 0, guest(DATA1), 16);
      queueChain(memory, {
        head: 0,
        dataSlot: 1,
        statusSlot: 2,
        headerAddress: HEADER1,
        dataAddress: DATA1,
        statusAddress: STATUS1,
        dataLength: 16,
        type: 0,
        sector: 1n,
      });
      writeU16(memory, AVAIL_BASE + 2n, 1);
      writeU16(memory, AVAIL_BASE + 4n, 0);

      writeVirtioRegister(memory, 0x050n, 0);
      assert.equal(usedIdx(memory), 0);

      await pollVirtioUntil(memory, () => usedIdx(memory) === 1);
      assert.equal(loadGuest(memory, STATUS1, 1)[0], 0);
      assert.deepEqual(loadGuest(memory, DATA1, 16), SECTOR_HEAD);
      assert.equal(readU32(memory, USED_BASE + 4n), 0);
      assert.equal(readU32(memory, USED_BASE + 8n), 17);
      assert.equal(readVirtioRegister(memory, 0x060n), 1);
      assert.equal(isPlicMachineExternalPending(memory), true);
      assert.equal(slotValid(memory, 0), false);
    });
  });

  it('InterruptACK bit 0 clears the interrupt and deasserts PLIC source 1', async () => {
    const memory = createTestMemory(512n);
    configureQueue(memory);
    await withDiskWorker(memory, async () => {
      queueChain(memory, {
        head: 0,
        dataSlot: 1,
        statusSlot: 2,
        headerAddress: HEADER1,
        dataAddress: DATA1,
        statusAddress: STATUS1,
        dataLength: 16,
        type: 0,
        sector: 1n,
      });
      writeU16(memory, AVAIL_BASE + 2n, 1);
      writeU16(memory, AVAIL_BASE + 4n, 0);
      writeVirtioRegister(memory, 0x050n, 0);
      await pollVirtioUntil(memory, () => usedIdx(memory) === 1);
      assert.equal(readVirtioRegister(memory, 0x060n), 1);
      assert.equal(isPlicMachineExternalPending(memory), true);

      writeVirtioRegister(memory, 0x064n, 1);
      assert.equal(readVirtioRegister(memory, 0x060n), 0);
      assert.equal(isPlicMachineExternalPending(memory), false);
      writeVirtioRegister(memory, 0x064n, 1);
    });
  });

  it('OUT request writes guest RAM back to the file asynchronously', async () => {
    const memory = createTestMemory(512n);
    configureQueue(memory);
    const outBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    await withDiskWorker(memory, async (path) => {
      storeGuest(memory, DATA1, outBytes);
      queueChain(memory, {
        head: 0,
        dataSlot: 1,
        statusSlot: 2,
        headerAddress: HEADER1,
        dataAddress: DATA1,
        statusAddress: STATUS1,
        dataLength: 16,
        type: 1,
        sector: 2n,
        dataWritable: false,
      });
      writeU16(memory, AVAIL_BASE + 2n, 1);
      writeU16(memory, AVAIL_BASE + 4n, 0);

      writeVirtioRegister(memory, 0x050n, 0);
      assert.equal(usedIdx(memory), 0);

      await pollVirtioUntil(memory, () => usedIdx(memory) === 1);
      assert.equal(loadGuest(memory, STATUS1, 1)[0], 0);
      assert.deepEqual(readFileBytes(path).subarray(1024, 1040), outBytes);
      assert.equal(readU32(memory, USED_BASE + 4n), 0);
      assert.equal(readU32(memory, USED_BASE + 8n), 1);
    });
  });

  it('requests serialize one-in-flight and complete in avail order', async () => {
    const memory = createTestMemory(512n);
    configureQueue(memory);
    await withDiskWorker(memory, async () => {
      writeDescriptor(memory, 3, {
        address: HEADER1,
        length: 16,
        flags: VRING_DESC_F_NEXT,
        next: 6,
      });
      writeDescriptor(memory, 6, {
        address: DATA1,
        length: 16,
        flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
        next: 7,
      });
      writeDescriptor(memory, 7, {
        address: STATUS1,
        length: 1,
        flags: VRING_DESC_F_WRITE,
        next: 0,
      });
      writeDescriptor(memory, 5, {
        address: HEADER2,
        length: 16,
        flags: VRING_DESC_F_NEXT,
        next: 0,
      });
      writeDescriptor(memory, 0, {
        address: DATA2,
        length: 16,
        flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
        next: 1,
      });
      writeDescriptor(memory, 1, {
        address: STATUS2,
        length: 1,
        flags: VRING_DESC_F_WRITE,
        next: 0,
      });
      // header 1 (sector 1) at HEADER1; header 2 (sector 2) at HEADER2
      const header1 = new Uint8Array(16);
      header1.set(unsignedBigIntToBytes(new Uint8Array(8), 1n), 8);
      storeGuest(memory, HEADER1, header1);
      const header2 = new Uint8Array(16);
      header2.set(unsignedBigIntToBytes(new Uint8Array(8), 2n), 8);
      storeGuest(memory, HEADER2, header2);
      writeU16(memory, AVAIL_BASE + 2n, 2);
      writeU16(memory, AVAIL_BASE + 4n, 3);
      writeU16(memory, AVAIL_BASE + 6n, 5);

      writeVirtioRegister(memory, 0x050n, 0);
      await pollVirtioUntil(memory, () => usedIdx(memory) === 2);

      assert.equal(loadGuest(memory, STATUS1, 1)[0], 0);
      assert.equal(loadGuest(memory, STATUS2, 1)[0], 0);
      assert.deepEqual(loadGuest(memory, DATA1, 16), SECTOR_HEAD);
      assert.deepEqual(loadGuest(memory, DATA2, 16), SECTOR_HEAD);
      assert.equal(readU32(memory, USED_BASE + 4n), 3);
      assert.equal(readU32(memory, USED_BASE + 8n), 17);
      assert.equal(readU32(memory, USED_BASE + 12n), 5);
      assert.equal(readU32(memory, USED_BASE + 16n), 17);

      writeVirtioRegister(memory, 0x064n, 1);
      writeVirtioRegister(memory, 0x050n, 0);
      pollVirtioDiskCompletions(memory);
      assert.equal(usedIdx(memory), 2);
      assert.equal(isPlicMachineExternalPending(memory), false);
    });
  });

  it('out-of-bounds and not-ready requests complete IOERR with no partial transfer', async () => {
    const memory = createTestMemory(512n);
    configureQueue(memory);
    await withDiskWorker(memory, async (path) => {
      storeGuest(memory, DATA1, new Uint8Array(16).fill(0xaa));
      queueChain(memory, {
        head: 0,
        dataSlot: 1,
        statusSlot: 2,
        headerAddress: HEADER1,
        dataAddress: DATA1,
        statusAddress: STATUS1,
        dataLength: 16,
        type: 0,
        sector: 100n,
      });
      writeU16(memory, AVAIL_BASE + 2n, 1);
      writeU16(memory, AVAIL_BASE + 4n, 0);
      writeVirtioRegister(memory, 0x050n, 0);
      await pollVirtioUntil(memory, () => usedIdx(memory) === 1);

      assert.equal(loadGuest(memory, STATUS1, 1)[0], 1);
      assert.deepEqual(loadGuest(memory, DATA1, 16), new Uint8Array(16).fill(0xaa));
      assert.deepEqual(readFileBytes(path).subarray(512, 528), SECTOR_HEAD);
    });

    // Worker-less: capacity stays 0, so a valid IN completes IOERR rather than hanging.
    const absent = createTestMemory(512n);
    configureQueue(absent);
    queueChain(absent, {
      head: 0,
      dataSlot: 1,
      statusSlot: 2,
      headerAddress: HEADER1,
      dataAddress: DATA1,
      statusAddress: STATUS1,
      dataLength: 16,
      type: 0,
      sector: 0n,
    });
    writeU16(absent, AVAIL_BASE + 2n, 1);
    writeU16(absent, AVAIL_BASE + 4n, 0);
    writeVirtioRegister(absent, 0x050n, 0);
    pollVirtioDiskCompletions(absent);
    assert.equal(usedIdx(absent), 1);
    assert.equal(loadGuest(absent, STATUS1, 1)[0], 1);
    assert.equal(readU32(absent, USED_BASE + 4n), 0);
    assert.equal(readU32(absent, USED_BASE + 8n), 1);
    assert.equal(isPlicMachineExternalPending(absent), true);
  });

  it('FLUSH completes OK and unknown types complete UNSUPP, with no file I/O', () => {
    const memory = createTestMemory(512n);
    configureQueue(memory);
    queueChain(memory, {
      head: 0,
      dataSlot: 1,
      statusSlot: 2,
      headerAddress: HEADER1,
      dataAddress: DATA1,
      statusAddress: STATUS1,
      dataLength: 16,
      type: 4,
      sector: 0n,
    });
    writeU16(memory, AVAIL_BASE + 2n, 1);
    writeU16(memory, AVAIL_BASE + 4n, 0);
    writeVirtioRegister(memory, 0x050n, 0);
    pollVirtioDiskCompletions(memory);
    assert.equal(usedIdx(memory), 1);
    assert.equal(loadGuest(memory, STATUS1, 1)[0], 0);
    assert.equal(readU32(memory, USED_BASE + 8n), 1);

    queueChain(memory, {
      head: 3,
      dataSlot: 4,
      statusSlot: 5,
      headerAddress: HEADER2,
      dataAddress: DATA2,
      statusAddress: STATUS2,
      dataLength: 16,
      type: 0x1234,
      sector: 0n,
    });
    writeU16(memory, AVAIL_BASE + 2n, 2);
    writeU16(memory, AVAIL_BASE + 6n, 3);
    writeVirtioRegister(memory, 0x050n, 0);
    pollVirtioDiskCompletions(memory);
    assert.equal(usedIdx(memory), 2);
    assert.equal(loadGuest(memory, STATUS2, 1)[0], 2);
  });

  it('QueueNotify triggers on the 0x50 byte of value 0, not on other bytes', () => {
    const memory = createTestMemory(512n);
    configureQueue(memory);
    queueChain(memory, {
      head: 0,
      dataSlot: 1,
      statusSlot: 2,
      headerAddress: HEADER1,
      dataAddress: DATA1,
      statusAddress: STATUS1,
      dataLength: 16,
      type: 0,
      sector: 0n,
    });
    writeU16(memory, AVAIL_BASE + 2n, 1);
    writeU16(memory, AVAIL_BASE + 4n, 0);

    // Byte 1 of QueueNotify: no kick — a broken wrapper would complete immediately.
    storeBytes({
      memory,
      address: virtioAddress(0x051n),
      source: new Uint8Array([0]),
      byteLength: 1,
    });
    assert.equal(usedIdx(memory), 0);

    // Byte 0 of QueueNotify: the queue-0 kick.
    storeBytes({
      memory,
      address: virtioAddress(0x050n),
      source: new Uint8Array([0]),
      byteLength: 1,
    });
    pollVirtioDiskCompletions(memory);
    assert.equal(usedIdx(memory), 1);
  });

  it('notify is gated on DRIVER_OK and QueueReady', () => {
    const memory = createTestMemory(512n);
    writeVirtioRegister(memory, 0x070n, 0);
    writeVirtioRegister(memory, 0x070n, 1);
    writeVirtioRegister(memory, 0x070n, 3);
    writeVirtioRegister(memory, 0x070n, 0xb); // FEATURES_OK, no DRIVER_OK
    writeVirtioRegister(memory, 0x030n, 0);
    writeVirtioRegister(memory, 0x038n, 8);
    writeVirtioRegister(memory, 0x080n, 0x000);
    writeVirtioRegister(memory, 0x090n, 0x080);
    writeVirtioRegister(memory, 0x0a0n, 0x0a0);
    armPlicVirtio(memory);
    queueChain(memory, {
      head: 0,
      dataSlot: 1,
      statusSlot: 2,
      headerAddress: HEADER1,
      dataAddress: DATA1,
      statusAddress: STATUS1,
      dataLength: 16,
      type: 0,
      sector: 0n,
    });
    writeU16(memory, AVAIL_BASE + 2n, 1);
    writeU16(memory, AVAIL_BASE + 4n, 0);

    writeVirtioRegister(memory, 0x050n, 0);
    pollVirtioDiskCompletions(memory);
    assert.equal(usedIdx(memory), 0);

    writeVirtioRegister(memory, 0x070n, 0xf); // DRIVER_OK, but QueueReady still 0
    writeVirtioRegister(memory, 0x050n, 0);
    pollVirtioDiskCompletions(memory);
    assert.equal(usedIdx(memory), 0);

    writeVirtioRegister(memory, 0x044n, 1);
    writeVirtioRegister(memory, 0x050n, 0);
    pollVirtioDiskCompletions(memory);
    assert.equal(usedIdx(memory), 1);
  });

  it('a malformed chain is skipped without wedging the device', () => {
    const memory = createTestMemory(512n);
    configureQueue(memory);
    // Valid chain: head 3 → 6 → 7.
    writeDescriptor(memory, 3, {
      address: HEADER1,
      length: 16,
      flags: VRING_DESC_F_NEXT,
      next: 6,
    });
    writeDescriptor(memory, 6, {
      address: DATA1,
      length: 16,
      flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
      next: 7,
    });
    writeDescriptor(memory, 7, {
      address: STATUS1,
      length: 1,
      flags: VRING_DESC_F_WRITE,
      next: 0,
    });
    // Cycle: head 4 → next 4.
    writeDescriptor(memory, 4, {
      address: DATA1,
      length: 16,
      flags: VRING_DESC_F_NEXT,
      next: 4,
    });
    writeU16(memory, AVAIL_BASE + 2n, 2);
    writeU16(memory, AVAIL_BASE + 4n, 8); // out of range (=== queueNum)
    writeU16(memory, AVAIL_BASE + 6n, 3); // valid

    writeVirtioRegister(memory, 0x050n, 0);
    pollVirtioDiskCompletions(memory);
    assert.equal(usedIdx(memory), 1);
    pollVirtioDiskCompletions(memory);
    assert.equal(usedIdx(memory), 1); // no-op

    writeU16(memory, AVAIL_BASE + 2n, 3);
    writeU16(memory, AVAIL_BASE + 8n, 4); // cycle chain
    writeVirtioRegister(memory, 0x050n, 0);
    pollVirtioDiskCompletions(memory);
    assert.equal(usedIdx(memory), 1); // skipped, bounded walk
  });

  it('a non-canonical chain with a trailing status descriptor completes IOERR', () => {
    const memory = createTestMemory(512n);
    configureQueue(memory);
    // 2-descriptor chain: header → status.
    writeDescriptor(memory, 0, {
      address: HEADER1,
      length: 16,
      flags: VRING_DESC_F_NEXT,
      next: 1,
    });
    writeDescriptor(memory, 1, {
      address: STATUS1,
      length: 1,
      flags: VRING_DESC_F_WRITE,
      next: 0,
    });
    const header = new Uint8Array(16);
    header.set(unsignedBigIntToBytes(new Uint8Array(8), 1n), 8);
    storeGuest(memory, HEADER1, header);
    // A second, valid slot on the same poll.
    queueChain(memory, {
      head: 3,
      dataSlot: 4,
      statusSlot: 5,
      headerAddress: HEADER2,
      dataAddress: DATA2,
      statusAddress: STATUS2,
      dataLength: 16,
      type: 0,
      sector: 0n,
    });
    writeU16(memory, AVAIL_BASE + 2n, 2);
    writeU16(memory, AVAIL_BASE + 4n, 0);
    writeU16(memory, AVAIL_BASE + 6n, 3);

    assert.equal(loadVirtioShadowU32(memory, VIRTIO_HOST_REQUEST_SEQ), 0);
    writeVirtioRegister(memory, 0x050n, 0);
    pollVirtioDiskCompletions(memory);
    assert.equal(usedIdx(memory), 2);
    assert.equal(loadGuest(memory, STATUS1, 1)[0], 1);
    assert.equal(readU32(memory, USED_BASE + 4n), 0);
    assert.equal(readU32(memory, USED_BASE + 8n), 1);
    assert.equal(loadVirtioShadowU32(memory, VIRTIO_HOST_REQUEST_SEQ), 0);
  });

  it('waitVirtioDiskCompletion parks on the completion wake word', async () => {
    const memory = createTestMemory(512n);
    configureQueue(memory);
    await withDiskWorker(memory, async () => {
      queueChain(memory, {
        head: 0,
        dataSlot: 1,
        statusSlot: 2,
        headerAddress: HEADER1,
        dataAddress: DATA1,
        statusAddress: STATUS1,
        dataLength: 16,
        type: 0,
        sector: 3n,
      });
      writeU16(memory, AVAIL_BASE + 2n, 1);
      writeU16(memory, AVAIL_BASE + 4n, 0);

      const fromLevel = loadVirtioDiskCompletionSeq(memory);
      writeVirtioRegister(memory, 0x050n, 0);
      await waitVirtioDiskCompletion(memory, fromLevel);
      pollVirtioDiskCompletions(memory);
      assert.equal(usedIdx(memory), 1);
    });
  });
});
