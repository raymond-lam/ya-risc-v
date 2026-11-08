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
import {
  atomicLoadReservedBytes,
  atomicStoreConditionalBytes,
  loadBytes,
  storeBytes,
  type Memory,
} from '#emulator/memory';
import { isClintMachineTimerPending } from '#emulator/clint';
import { popUartTransmit } from '#emulator/uart';
import { isPlicMachineExternalPending, plicGatewayLockIndex } from '#emulator/plic';
import {
  RESERVATION_REGION_ID,
  reservationLockIndex,
  setReservationLocked,
} from '#emulator/reservation';
import { createVirtioDisk, type VirtioDiskHandle } from '#emulator/virtio';
import { initializeVirtio } from '#emulator/virtio';
import {
  VIRTIO_HOST_QUEUE_EPOCH,
  VRING_DESC_F_NEXT,
  VRING_DESC_F_WRITE,
  loadVirtioDiskCapacity,
  loadVirtioShadowU32,
  loadVirtioDevicePresent,
} from '#emulator/virtio/layout';
import { claimVirtioRequest, completeVirtioRequest } from '#emulator/virtio/queue';
import { openDiskImage, closeDiskImage } from '#emulator/virtio/disk';
import { armVirtioDiskService, serviceVirtioDiskRequests } from '#emulator/virtio/service';
import withSharedLocks from '#emulator/with-shared-locks';
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

const waitUntil = async (predicate: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 1000; i++) {
    if (await predicate()) return;
    await delay(1);
  }
  assert.fail('queue did not complete');
};

/** Run `body` against a real disk worker with a fresh temp image. */
const withDiskWorker = async (
  memory: Memory,
  body: (diskImagePath: string) => Promise<void> | void
): Promise<void> => {
  const { dir, path } = writeTempDiskImage(buildDiskImage());
  const disk: VirtioDiskHandle = createVirtioDisk({ memory, diskImagePath: path });
  await disk.start();
  try {
    await body(path);
  } finally {
    await disk.stop();
    await disk;
    rmSync(dir, { recursive: true, force: true });
  }
};

const usedIdx = (memory: Memory): Promise<number> => readU16(memory, USED_BASE + 2n);

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
const waitForQueue = async (memory: Memory, predicate: () => Promise<boolean>): Promise<void> => {
  await waitUntil(predicate);
};

describe('virtio queue engine', () => {
  it(
    'unit: held I/O permits UART/CLINT progress and suppresses reset-era publication',
    { timeout: 5000 },
    async (context) => {
      const memory = createTestMemory(512n);
      const { dir, path } = writeTempDiskImage(buildDiskImage());
      const disk = await openDiskImage(path);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const stop = new AbortController();
      context.mock.method(disk.fileHandle, 'read', async () => {
        entered.resolve();
        await release.promise;
        return { bytesRead: 0, buffer: new Uint8Array(0) };
      });
      const handled = armVirtioDiskService(memory, disk.sizeBytes);
      await configureQueue(memory);
      await queueChain(memory, {
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
      await storeGuest(memory, DATA1, new Uint8Array(16).fill(0xee));
      await storeGuest(memory, STATUS1, new Uint8Array([0xff]));
      await writeU16(memory, AVAIL_BASE + 4n, 0);
      await writeU16(memory, AVAIL_BASE + 2n, 1);
      const service = serviceVirtioDiskRequests(memory, disk, handled, stop.signal);
      try {
        await writeVirtioRegister(memory, 0x050n, 0);
        await entered.promise;
        // These real device handlers must finish before the suspended disk read is released.
        await storeGuest(memory, 0x1000_0000n, new Uint8Array([0x41]));
        assert.equal(await popUartTransmit(memory), 0x41);
        assert.equal(await popUartTransmit(memory), null);
        assert.equal((await loadGuest(memory, 0x1000_0005n, 1))[0]! & 0x60, 0x60);
        await storeGuest(memory, 0x0200_4000n, new Uint8Array(8));
        assert.equal(isClintMachineTimerPending(memory), true);
        const disabledCompare = new Uint8Array(8).fill(0xff);
        await storeGuest(memory, 0x0200_4000n, disabledCompare);
        assert.deepEqual(await loadGuest(memory, 0x0200_4000n, 8), disabledCompare);
        assert.equal(isClintMachineTimerPending(memory), false);
        await writeVirtioRegister(memory, 0x070n, 0); // completes while file read is held
        await storeGuest(memory, 0x1c0n, new Uint8Array([0x5a]));
        await configureQueue(memory);
        await queueChain(memory, {
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
        await writeU16(memory, AVAIL_BASE + 4n, 3);
        await writeVirtioRegister(memory, 0x050n, 0);
        release.resolve();
        await waitUntil(async () => (await usedIdx(memory)) === 1);
        stop.abort();
        await service;
        assert.equal(await readU32(memory, USED_BASE + 4n), 3);
        assert.equal((await loadGuest(memory, STATUS2, 1))[0], 2);
        assert.deepEqual(await loadGuest(memory, DATA1, 16), new Uint8Array(16).fill(0xee));
        assert.equal((await loadGuest(memory, STATUS1, 1))[0], 0xff);
        assert.equal((await loadGuest(memory, 0x1c0n, 1))[0], 0x5a);
        assert.equal(await readVirtioRegister(memory, 0x060n), 1);
      } finally {
        release.resolve();
        stop.abort();
        await service;
        await closeDiskImage(disk);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
  it('oversized available deltas publish nothing, including after re-notification', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await queueChain(memory, {
      head: 0,
      dataSlot: 1,
      statusSlot: 2,
      headerAddress: HEADER1,
      dataAddress: DATA1,
      statusAddress: STATUS1,
      dataLength: 16,
      type: 0x1234,
      sector: 0n,
    });
    await storeGuest(memory, DATA1, new Uint8Array(16).fill(0xee));
    await storeGuest(memory, STATUS1, new Uint8Array([0xff]));
    await writeU16(memory, AVAIL_BASE + 4n, 0);
    await writeU16(memory, AVAIL_BASE + 2n, 9); // queue depth is eight
    const before = await loadGuest(memory, 0n, 512);
    const state = {
      epoch: loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_EPOCH),
      lastAvail: 0,
      kicked: false,
    };
    for (let notify = 0; notify < 2; notify += 1) {
      await writeVirtioRegister(memory, 0x050n, 0);
      state.kicked = true; // model the worker consuming this notification
      assert.equal(claimVirtioRequest(memory, state), null);
      assert.equal(state.lastAvail, 0);
      assert.equal(state.kicked, false);
      assert.deepEqual(await loadGuest(memory, 0n, 512), before);
      assert.equal(await usedIdx(memory), 0);
      assert.equal(await readVirtioRegister(memory, 0x060n), 0);
      assert.equal(isPlicMachineExternalPending(memory), false);
    }
    await writeU16(memory, AVAIL_BASE + 2n, 1); // repair index, then notify
    await writeVirtioRegister(memory, 0x050n, 0);
    state.kicked = true;
    const request = claimVirtioRequest(memory, state);
    assert.ok(request);
    completeVirtioRequest(memory, request, false);
    assert.equal(await usedIdx(memory), 1);
    assert.equal(await readU32(memory, USED_BASE + 4n), 0);
    assert.equal((await loadGuest(memory, STATUS1, 1))[0], 2);
    assert.deepEqual(await loadGuest(memory, DATA1, 16), new Uint8Array(16).fill(0xee));
  });
  it('used.len DMA consumes an LR on the next line, not an unrelated reservation', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await writeVirtioRegister(memory, 0x044n, 0);
    await writeVirtioRegister(memory, 0x0a0n, 0x38);
    await writeVirtioRegister(memory, 0x044n, 1);
    await queueChain(memory, {
      head: 0,
      dataSlot: 1,
      statusSlot: 2,
      headerAddress: HEADER1,
      dataAddress: DATA1,
      statusAddress: STATUS1,
      dataLength: 16,
      type: 0x1234,
      sector: 0n,
    });
    for (const [hartId, address] of [
      [0, 0x40n],
      [1, 0x1c0n],
    ] as const) {
      assert.equal(
        await atomicLoadReservedBytes({
          hartId,
          memory,
          address: guest(address),
          destination: new Uint8Array(8),
          byteLength: 4,
        }),
        true
      );
    }
    await writeU16(memory, AVAIL_BASE + 4n, 0);
    await writeU16(memory, AVAIL_BASE + 2n, 1);
    await pumpUnitQueue(memory);
    assert.equal(
      await atomicStoreConditionalBytes({
        hartId: 0,
        memory,
        address: guest(0x40n),
        source: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
        byteLength: 4,
      }),
      false
    );
    assert.equal(await readU32(memory, 0x40n), 1);
    assert.equal(
      await atomicStoreConditionalBytes({
        hartId: 1,
        memory,
        address: guest(0x1c0n),
        source: new Uint8Array([0x5a, 0, 0, 0]),
        byteLength: 4,
      }),
      true
    );
  });
  it('unaligned IN DMA preserves neighboring bytes', { timeout: 5000 }, async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await withDiskWorker(memory, async () => {
      await storeGuest(memory, DATA1, new Uint8Array(24).fill(0xee));
      await queueChain(memory, {
        head: 0,
        dataSlot: 1,
        statusSlot: 2,
        headerAddress: HEADER1,
        dataAddress: DATA1 + 1n,
        statusAddress: STATUS1,
        dataLength: 16,
        type: 0,
        sector: 0n,
      });
      await writeU16(memory, AVAIL_BASE + 4n, 0);
      await writeU16(memory, AVAIL_BASE + 2n, 1);
      await writeVirtioRegister(memory, 0x050n, 0);
      await waitUntil(async () => (await usedIdx(memory)) === 1);
      const expected = new Uint8Array(24).fill(0xee);
      expected.set(SECTOR_HEAD, 1);
      assert.deepEqual(await loadGuest(memory, DATA1, 24), expected);
    });
  });
  it('claimed descriptors cannot redirect later DMA', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    armVirtioDiskService(memory, 4096n);
    await storeGuest(memory, DATA1, new Uint8Array(32).fill(0xee));
    await queueChain(memory, {
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
    await writeU16(memory, AVAIL_BASE + 4n, 0);
    await writeU16(memory, AVAIL_BASE + 2n, 1);
    const request = claimVirtioRequest(memory, {
      epoch: loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_EPOCH),
      lastAvail: 0,
      kicked: true,
    });
    assert.ok(request);
    await writeDescriptor(memory, 1, {
      address: DATA2,
      length: 16,
      flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
      next: 2,
    });
    request.data.set(SECTOR_HEAD);
    completeVirtioRequest(memory, request, false);
    assert.deepEqual(await loadGuest(memory, DATA1, 16), SECTOR_HEAD);
    assert.deepEqual(await loadGuest(memory, DATA2, 16), new Uint8Array(16).fill(0xee));
    assert.equal(await usedIdx(memory), 1);
  });
  it(
    'short backing read publishes IOERR without partial guest DMA',
    { timeout: 5000 },
    async () => {
      const memory = createTestMemory(512n);
      await configureQueue(memory);
      await withDiskWorker(memory, async (path) => {
        writeFileSync(path, new Uint8Array(0)); // capacity was published before host truncation
        await storeGuest(memory, DATA1, new Uint8Array(16).fill(0xee));
        await queueChain(memory, {
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
        await writeU16(memory, AVAIL_BASE + 4n, 0);
        await writeU16(memory, AVAIL_BASE + 2n, 1);
        await writeVirtioRegister(memory, 0x050n, 0);
        await waitUntil(async () => (await usedIdx(memory)) === 1);
        assert.deepEqual(await loadGuest(memory, DATA1, 16), new Uint8Array(16).fill(0xee));
        assert.equal((await loadGuest(memory, STATUS1, 1))[0], 1);
        assert.equal(await readU32(memory, USED_BASE + 8n), 1);
        assert.equal(await readVirtioRegister(memory, 0x060n), 1);
      });
    }
  );
  it('publishes DMA, used entry and IRQ without any hart service', { timeout: 5000 }, async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await withDiskWorker(memory, async () => {
      await queueChain(memory, {
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
      await storeGuest(memory, STATUS1, new Uint8Array([0xff]));
      await setReservation(memory, 0, guest(DATA1), 8);
      await writeU16(memory, AVAIL_BASE + 4n, 0);
      await writeU16(memory, AVAIL_BASE + 2n, 1);
      await writeVirtioRegister(memory, 0x050n, 0);
      await waitUntil(async () => (await usedIdx(memory)) === 1);
      assert.deepEqual(await loadGuest(memory, DATA1, 16), SECTOR_HEAD);
      assert.equal((await loadGuest(memory, STATUS1, 1))[0], 0);
      assert.equal(await readU32(memory, USED_BASE + 8n), 17);
      assert.equal(await readVirtioRegister(memory, 0x060n), 1);
      assert.equal(isPlicMachineExternalPending(memory), true);
      assert.equal(slotValid(memory, 0), false);
      await writeVirtioRegister(memory, 0x064n, 1);
      assert.equal(await readVirtioRegister(memory, 0x060n), 0);
    });
  });
  it('rejects stale claimed DMA after reset and queue deactivation', async () => {
    for (const control of [0x070n, 0x044n]) {
      const memory = createTestMemory(512n);
      armVirtioDiskService(memory, 4096n);
      await configureQueue(memory);
      await queueChain(memory, {
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
      await storeGuest(memory, DATA1, new Uint8Array(16).fill(0xee));
      await storeGuest(memory, STATUS1, new Uint8Array([0xff]));
      await writeU16(memory, AVAIL_BASE + 4n, 0);
      await writeU16(memory, AVAIL_BASE + 2n, 1);
      const state = {
        epoch: loadVirtioShadowU32(memory, VIRTIO_HOST_QUEUE_EPOCH),
        lastAvail: 0,
        kicked: true,
      };
      const request = claimVirtioRequest(memory, state);
      assert.ok(request);
      request.data.fill(0xaa);
      await writeVirtioRegister(memory, control, 0);
      await configureQueue(memory);
      completeVirtioRequest(memory, request, false);
      assert.equal(await usedIdx(memory), 0);
      assert.equal((await loadGuest(memory, STATUS1, 1))[0], 0xff);
      assert.deepEqual(await loadGuest(memory, DATA1, 16), new Uint8Array(16).fill(0xee));
      assert.equal(isPlicMachineExternalPending(memory), false);
    }
  });
  it('InterruptACK bit 0 clears the interrupt and deasserts PLIC source 1', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await withDiskWorker(memory, async () => {
      await queueChain(memory, {
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
      await writeU16(memory, AVAIL_BASE + 2n, 1);
      await writeU16(memory, AVAIL_BASE + 4n, 0);
      await writeVirtioRegister(memory, 0x050n, 0);
      await waitForQueue(memory, async () => (await usedIdx(memory)) === 1);
      assert.equal(await readVirtioRegister(memory, 0x060n), 1);
      assert.equal(isPlicMachineExternalPending(memory), true);

      await writeVirtioRegister(memory, 0x064n, 1);
      assert.equal(await readVirtioRegister(memory, 0x060n), 0);
      assert.equal(isPlicMachineExternalPending(memory), false);
      await writeVirtioRegister(memory, 0x064n, 1);
    });
  });

  it('OUT request writes guest RAM back to the file asynchronously', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    const outBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    await withDiskWorker(memory, async (path) => {
      await storeGuest(memory, DATA1, outBytes);
      await queueChain(memory, {
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
      await writeU16(memory, AVAIL_BASE + 2n, 1);
      await writeU16(memory, AVAIL_BASE + 4n, 0);

      await writeVirtioRegister(memory, 0x050n, 0);

      await waitForQueue(memory, async () => (await usedIdx(memory)) === 1);
      assert.equal((await loadGuest(memory, STATUS1, 1))[0], 0);
      assert.deepEqual(readFileBytes(path).subarray(1024, 1040), outBytes);
      assert.equal(await readU32(memory, USED_BASE + 4n), 0);
      assert.equal(await readU32(memory, USED_BASE + 8n), 1);
    });
  });

  it('requests serialize one-in-flight and complete in avail order', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await withDiskWorker(memory, async () => {
      await writeDescriptor(memory, 3, {
        address: HEADER1,
        length: 16,
        flags: VRING_DESC_F_NEXT,
        next: 6,
      });
      await writeDescriptor(memory, 6, {
        address: DATA1,
        length: 16,
        flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
        next: 7,
      });
      await writeDescriptor(memory, 7, {
        address: STATUS1,
        length: 1,
        flags: VRING_DESC_F_WRITE,
        next: 0,
      });
      await writeDescriptor(memory, 5, {
        address: HEADER2,
        length: 16,
        flags: VRING_DESC_F_NEXT,
        next: 0,
      });
      await writeDescriptor(memory, 0, {
        address: DATA2,
        length: 16,
        flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
        next: 1,
      });
      await writeDescriptor(memory, 1, {
        address: STATUS2,
        length: 1,
        flags: VRING_DESC_F_WRITE,
        next: 0,
      });
      // header 1 (sector 1) at HEADER1; header 2 (sector 2) at HEADER2
      const header1 = new Uint8Array(16);
      header1.set(unsignedBigIntToBytes(new Uint8Array(8), 1n), 8);
      await storeGuest(memory, HEADER1, header1);
      const header2 = new Uint8Array(16);
      header2.set(unsignedBigIntToBytes(new Uint8Array(8), 2n), 8);
      await storeGuest(memory, HEADER2, header2);
      await writeU16(memory, AVAIL_BASE + 2n, 2);
      await writeU16(memory, AVAIL_BASE + 4n, 3);
      await writeU16(memory, AVAIL_BASE + 6n, 5);

      await writeVirtioRegister(memory, 0x050n, 0);
      await waitForQueue(memory, async () => (await usedIdx(memory)) === 2);

      assert.equal((await loadGuest(memory, STATUS1, 1))[0], 0);
      assert.equal((await loadGuest(memory, STATUS2, 1))[0], 0);
      assert.deepEqual(await loadGuest(memory, DATA1, 16), SECTOR_HEAD);
      assert.deepEqual(await loadGuest(memory, DATA2, 16), SECTOR_HEAD);
      assert.equal(await readU32(memory, USED_BASE + 4n), 3);
      assert.equal(await readU32(memory, USED_BASE + 8n), 17);
      assert.equal(await readU32(memory, USED_BASE + 12n), 5);
      assert.equal(await readU32(memory, USED_BASE + 16n), 17);

      await writeVirtioRegister(memory, 0x064n, 1);
      await writeVirtioRegister(memory, 0x050n, 0);
      await pumpUnitQueue(memory);
      assert.equal(await usedIdx(memory), 2);
      assert.equal(isPlicMachineExternalPending(memory), false);
    });
  });

  it('out-of-bounds and not-ready requests complete IOERR with no partial transfer', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await withDiskWorker(memory, async (path) => {
      await storeGuest(memory, DATA1, new Uint8Array(16).fill(0xaa));
      await queueChain(memory, {
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
      await writeU16(memory, AVAIL_BASE + 2n, 1);
      await writeU16(memory, AVAIL_BASE + 4n, 0);
      await writeVirtioRegister(memory, 0x050n, 0);
      await waitForQueue(memory, async () => (await usedIdx(memory)) === 1);

      assert.equal((await loadGuest(memory, STATUS1, 1))[0], 1);
      assert.deepEqual(await loadGuest(memory, DATA1, 16), new Uint8Array(16).fill(0xaa));
      assert.deepEqual(readFileBytes(path).subarray(512, 528), SECTOR_HEAD);
    });

    // Worker-less: capacity stays 0, so a valid IN completes IOERR rather than hanging.
    const absent = createTestMemory(512n);
    await configureQueue(absent);
    await queueChain(absent, {
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
    await writeU16(absent, AVAIL_BASE + 2n, 1);
    await writeU16(absent, AVAIL_BASE + 4n, 0);
    await writeVirtioRegister(absent, 0x050n, 0);
    await pumpUnitQueue(absent);
    assert.equal(await usedIdx(absent), 1);
    assert.equal((await loadGuest(absent, STATUS1, 1))[0], 1);
    assert.equal(await readU32(absent, USED_BASE + 4n), 0);
    assert.equal(await readU32(absent, USED_BASE + 8n), 1);
    assert.equal(isPlicMachineExternalPending(absent), true);
  });

  it('unadvertised FLUSH completes UNSUPP and unknown types complete UNSUPP, with no file I/O', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await queueChain(memory, {
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
    await writeU16(memory, AVAIL_BASE + 2n, 1);
    await writeU16(memory, AVAIL_BASE + 4n, 0);
    await writeVirtioRegister(memory, 0x050n, 0);
    // Unit pump models worker consumption; notify never publishes by itself.
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 1);
    assert.equal((await loadGuest(memory, STATUS1, 1))[0], 2);
    assert.equal(await readU32(memory, USED_BASE + 8n), 1);

    await queueChain(memory, {
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
    await writeU16(memory, AVAIL_BASE + 2n, 2);
    await writeU16(memory, AVAIL_BASE + 6n, 3);
    await writeVirtioRegister(memory, 0x050n, 0);
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 2);
    assert.equal((await loadGuest(memory, STATUS2, 1))[0], 2);
  });

  it('notify is gated on DRIVER_OK and QueueReady', async () => {
    const memory = createTestMemory(512n);
    await writeVirtioRegister(memory, 0x070n, 0);
    await writeVirtioRegister(memory, 0x070n, 1);
    await writeVirtioRegister(memory, 0x070n, 3);
    await writeVirtioRegister(memory, 0x070n, 0xb); // FEATURES_OK, no DRIVER_OK
    await writeVirtioRegister(memory, 0x030n, 0);
    await writeVirtioRegister(memory, 0x038n, 8);
    await writeVirtioRegister(memory, 0x080n, 0x000);
    await writeVirtioRegister(memory, 0x090n, 0x080);
    await writeVirtioRegister(memory, 0x0a0n, 0x0a0);
    await armPlicVirtio(memory);
    await queueChain(memory, {
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
    await writeU16(memory, AVAIL_BASE + 2n, 1);
    await writeU16(memory, AVAIL_BASE + 4n, 0);

    await writeVirtioRegister(memory, 0x050n, 0);
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 0);

    await writeVirtioRegister(memory, 0x070n, 0xf); // DRIVER_OK, but QueueReady still 0
    await writeVirtioRegister(memory, 0x050n, 0);
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 0);

    await writeVirtioRegister(memory, 0x044n, 1);
    await writeVirtioRegister(memory, 0x050n, 0);
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 1);
  });

  it('a malformed chain is skipped without wedging the device', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    // Valid chain: head 3 → 6 → 7.
    await writeDescriptor(memory, 3, {
      address: HEADER1,
      length: 16,
      flags: VRING_DESC_F_NEXT,
      next: 6,
    });
    await writeDescriptor(memory, 6, {
      address: DATA1,
      length: 16,
      flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
      next: 7,
    });
    await writeDescriptor(memory, 7, {
      address: STATUS1,
      length: 1,
      flags: VRING_DESC_F_WRITE,
      next: 0,
    });
    // Cycle: head 4 → next 4.
    await writeDescriptor(memory, 4, {
      address: DATA1,
      length: 16,
      flags: VRING_DESC_F_NEXT,
      next: 4,
    });
    await writeU16(memory, AVAIL_BASE + 2n, 2);
    await writeU16(memory, AVAIL_BASE + 4n, 8); // out of range (=== queueNum)
    await writeU16(memory, AVAIL_BASE + 6n, 3); // valid

    await writeVirtioRegister(memory, 0x050n, 0);
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 1);
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 1); // no-op

    await writeU16(memory, AVAIL_BASE + 2n, 3);
    await writeU16(memory, AVAIL_BASE + 8n, 4); // cycle chain
    await writeVirtioRegister(memory, 0x050n, 0);
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 1); // skipped, bounded walk
  });

  it('a non-canonical chain with a trailing status descriptor completes IOERR', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    // 2-descriptor chain: header → status.
    await writeDescriptor(memory, 0, {
      address: HEADER1,
      length: 16,
      flags: VRING_DESC_F_NEXT,
      next: 1,
    });
    await writeDescriptor(memory, 1, {
      address: STATUS1,
      length: 1,
      flags: VRING_DESC_F_WRITE,
      next: 0,
    });
    const header = new Uint8Array(16);
    header.set(unsignedBigIntToBytes(new Uint8Array(8), 1n), 8);
    await storeGuest(memory, HEADER1, header);
    // A second, valid slot on the same poll.
    await queueChain(memory, {
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
    await writeU16(memory, AVAIL_BASE + 2n, 2);
    await writeU16(memory, AVAIL_BASE + 4n, 0);
    await writeU16(memory, AVAIL_BASE + 6n, 3);

    await writeVirtioRegister(memory, 0x050n, 0);
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 2);
    assert.equal((await loadGuest(memory, STATUS1, 1))[0], 1);
    assert.equal(await readU32(memory, USED_BASE + 4n), 0);
    assert.equal(await readU32(memory, USED_BASE + 8n), 1);
  });

  it('multi-segment IN chain (header + 3 data + status) scatters staged bytes (§FIX 5)', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await withDiskWorker(memory, async () => {
      await storeGuest(memory, DATA1, new Uint8Array(4).fill(0xee));
      await storeGuest(memory, DATA2, new Uint8Array(8).fill(0xdd));
      await storeGuest(memory, DATA3, new Uint8Array(4).fill(0xcc));
      await storeGuest(memory, STATUS1, new Uint8Array([0xff]));

      await writeDescriptor(memory, 0, {
        address: HEADER1,
        length: 16,
        flags: VRING_DESC_F_NEXT,
        next: 1,
      });
      await writeDescriptor(memory, 1, {
        address: DATA1,
        length: 4,
        flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
        next: 2,
      });
      await writeDescriptor(memory, 2, {
        address: DATA2,
        length: 8,
        flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
        next: 3,
      });
      await writeDescriptor(memory, 3, {
        address: DATA3,
        length: 4,
        flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
        next: 4,
      });
      await writeDescriptor(memory, 4, {
        address: STATUS1,
        length: 1,
        flags: VRING_DESC_F_WRITE,
        next: 0,
      });
      await writeBlockHeader(memory, 0, 1n); // IN, sector 1

      await writeU16(memory, AVAIL_BASE + 2n, 1);
      await writeU16(memory, AVAIL_BASE + 4n, 0);
      await writeVirtioRegister(memory, 0x050n, 0);

      await waitForQueue(memory, async () => (await usedIdx(memory)) === 1);
      assert.equal((await loadGuest(memory, STATUS1, 1))[0], 0);
      assert.deepEqual(await loadGuest(memory, DATA1, 4), SECTOR_HEAD.subarray(0, 4));
      assert.deepEqual(await loadGuest(memory, DATA2, 8), SECTOR_HEAD.subarray(4, 12));
      assert.deepEqual(await loadGuest(memory, DATA3, 4), SECTOR_HEAD.subarray(12, 16));
      assert.equal(await readU32(memory, USED_BASE + 8n), 17); // used->len = data total + 1
    });
  });

  it('multi-segment OUT chain (header + 3 data + status) gathers staged bytes (§FIX 5)', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    const seg1 = new Uint8Array([0x10, 0x11, 0x12, 0x13]);
    const seg2 = new Uint8Array([0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27]);
    const seg3 = new Uint8Array([0x30, 0x31, 0x32, 0x33]);
    await withDiskWorker(memory, async (path) => {
      await storeGuest(memory, DATA1, seg1);
      await storeGuest(memory, DATA2, seg2);
      await storeGuest(memory, DATA3, seg3);
      await storeGuest(memory, STATUS1, new Uint8Array([0xff]));

      await writeDescriptor(memory, 0, {
        address: HEADER1,
        length: 16,
        flags: VRING_DESC_F_NEXT,
        next: 1,
      });
      await writeDescriptor(memory, 1, {
        address: DATA1,
        length: 4,
        flags: VRING_DESC_F_NEXT,
        next: 2,
      });
      await writeDescriptor(memory, 2, {
        address: DATA2,
        length: 8,
        flags: VRING_DESC_F_NEXT,
        next: 3,
      });
      await writeDescriptor(memory, 3, {
        address: DATA3,
        length: 4,
        flags: VRING_DESC_F_NEXT,
        next: 4,
      });
      await writeDescriptor(memory, 4, {
        address: STATUS1,
        length: 1,
        flags: VRING_DESC_F_WRITE,
        next: 0,
      });
      await writeBlockHeader(memory, 1, 0n); // OUT, sector 0

      await writeU16(memory, AVAIL_BASE + 2n, 1);
      await writeU16(memory, AVAIL_BASE + 4n, 0);
      await writeVirtioRegister(memory, 0x050n, 0);

      await waitForQueue(memory, async () => (await usedIdx(memory)) === 1);
      assert.equal((await loadGuest(memory, STATUS1, 1))[0], 0);
      assert.equal(await readU32(memory, USED_BASE + 8n), 1); // used->len = 1 for OUT

      const onDisk = readFileBytes(path);
      assert.deepEqual(onDisk.subarray(0, 4), seg1);
      assert.deepEqual(onDisk.subarray(4, 12), seg2);
      assert.deepEqual(onDisk.subarray(12, 16), seg3);
    });
  });

  it('a mixed-direction data section completes IOERR (§FIX 5)', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await storeGuest(memory, STATUS1, new Uint8Array([0xff]));
    await writeDescriptor(memory, 0, {
      address: HEADER1,
      length: 16,
      flags: VRING_DESC_F_NEXT,
      next: 1,
    });
    await writeDescriptor(memory, 1, {
      address: DATA1,
      length: 4,
      flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
      next: 2,
    });
    await writeDescriptor(memory, 2, {
      address: DATA2,
      length: 4,
      flags: VRING_DESC_F_NEXT,
      next: 3,
    });
    await writeDescriptor(memory, 3, {
      address: STATUS1,
      length: 1,
      flags: VRING_DESC_F_WRITE,
      next: 0,
    });
    await writeBlockHeader(memory, 0, 0n); // IN
    await writeU16(memory, AVAIL_BASE + 2n, 1);
    await writeU16(memory, AVAIL_BASE + 4n, 0);
    await writeVirtioRegister(memory, 0x050n, 0);
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 1);
    assert.equal((await loadGuest(memory, STATUS1, 1))[0], 1); // IOERR
    assert.equal(await readU32(memory, USED_BASE + 8n), 1);
  });

  it('a data section longer than the worker-local transfer limit completes IOERR with no transfer (§FIX 5)', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await storeGuest(memory, STATUS1, new Uint8Array([0xff]));
    await writeDescriptor(memory, 0, {
      address: HEADER1,
      length: 16,
      flags: VRING_DESC_F_NEXT,
      next: 1,
    });
    await writeDescriptor(memory, 1, {
      address: DATA1,
      length: 4096,
      flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
      next: 2,
    });
    await writeDescriptor(memory, 2, {
      address: DATA2,
      length: 1,
      flags: VRING_DESC_F_WRITE | VRING_DESC_F_NEXT,
      next: 3,
    });
    await writeDescriptor(memory, 3, {
      address: STATUS1,
      length: 1,
      flags: VRING_DESC_F_WRITE,
      next: 0,
    });
    await writeBlockHeader(memory, 0, 0n); // IN; total 4097 bytes > 4096
    await writeU16(memory, AVAIL_BASE + 2n, 1);
    await writeU16(memory, AVAIL_BASE + 4n, 0);
    await writeVirtioRegister(memory, 0x050n, 0);
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 1);
    assert.equal((await loadGuest(memory, STATUS1, 1))[0], 1); // IOERR
  });

  it('a request submitted only after the device appears is served, not absorbed (§FIX 1)', async () => {
    const memory = createTestMemory(512n);
    initializeVirtio(memory, false); // absent until the disk worker reports ready

    const { dir, path } = writeTempDiskImage(buildDiskImage());
    const disk: VirtioDiskHandle = createVirtioDisk({ memory, diskImagePath: path });
    await disk.start();
    try {
      // Startup itself guarantees that the device is armed and presented.
      assert.equal(loadVirtioDevicePresent(memory), 1);

      // Configure the queue after appearance, then submit; the request must be served.
      await configureQueue(memory);
      await queueChain(memory, {
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
      await storeGuest(memory, STATUS1, new Uint8Array([0xff]));
      await writeU16(memory, AVAIL_BASE + 2n, 1);
      await writeU16(memory, AVAIL_BASE + 4n, 0);
      await writeVirtioRegister(memory, 0x050n, 0);

      await waitForQueue(memory, async () => (await usedIdx(memory)) === 1);
      assert.equal((await loadGuest(memory, STATUS1, 1))[0], 0);
      assert.deepEqual(await loadGuest(memory, DATA1, 16), SECTOR_HEAD);
    } finally {
      await disk.stop();
      await disk;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
