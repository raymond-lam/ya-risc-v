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
import { initializeVirtio, loadBytesFromVirtio } from '#emulator/virtio';
import {
  VIRTIO_HOST_DISK_CAPACITY_HIGH,
  VIRTIO_HOST_DISK_CAPACITY_LOW,
  VIRTIO_HOST_DISK_CAPACITY_READY,
  VIRTIO_HOST_QUEUE_EPOCH,
  VIRTIO_HOST_WAKE_SEQ,
  VRING_DESC_F_NEXT,
  VRING_DESC_F_WRITE,
  virtioHostInt32,
} from '#emulator/virtio/layout';
import {
  loadVirtioDevicePresent,
  loadVirtioDiskCapacity,
  loadVirtioShadowU32,
  storeVirtioDevicePresent,
} from '#emulator/virtio/registers';
import { claimVirtioRequest, completeVirtioRequest } from '#emulator/virtio/queue';
import { openDiskImage, closeDiskImage } from '#emulator/virtio/disk';
import {
  clearVirtioDiskCapacity,
  publishVirtioDiskCapacity,
  runVirtioDiskDevice,
} from '#emulator/virtio/device';
import withSharedLocks from '#emulator/with-shared-locks';
import type { ReadonlyUint8Array } from '#types';
import { bytesToNumber, unsignedBigIntToBytes, unsignedNumberToBytes } from '#utils/bytes';
import { bigIntAsNumber } from '#utils/int';
import createTestMemory from '#test/guest-memory';
import {
  AVAIL_BASE,
  DATA1,
  DATA2,
  DATA3,
  HEADER1,
  HEADER2,
  SECTOR_HEAD,
  STATUS1,
  STATUS2,
  USED_BASE,
  armPlicVirtio,
  configureQueue,
  guest,
  loadGuest,
  queueChain,
  pumpUnitQueue,
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
} from '#test/virtio-queue';
import type { ChainSpec } from '#test/virtio-queue';

const TEMP_PREFIX = 'ya-risc-v-virtio-';

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

describe('virtio disk device', () => {
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
      publishVirtioDiskCapacity(memory, disk.sizeBytes);
      const handled = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_WAKE_SEQ), 0) >>> 0;
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
      const device = runVirtioDiskDevice(memory, disk, handled, stop.signal);
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
        await device;
        assert.equal(await readU32(memory, USED_BASE + 4n), 3);
        assert.equal((await loadGuest(memory, STATUS2, 1))[0], 2);
        assert.deepEqual(await loadGuest(memory, DATA1, 16), new Uint8Array(16).fill(0xee));
        assert.equal((await loadGuest(memory, STATUS1, 1))[0], 0xff);
        assert.equal((await loadGuest(memory, 0x1c0n, 1))[0], 0x5a);
        assert.equal(await readVirtioRegister(memory, 0x060n), 1);
      } finally {
        release.resolve();
        stop.abort();
        await device;
        await closeDiskImage(disk);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

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
    publishVirtioDiskCapacity(memory, 4096n);
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
      publishVirtioDiskCapacity(memory, 4096n);
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

  it('an OUT request with a data segment outside RAM completes IOERR without touching the disk', async () => {
    const memory = createTestMemory(512n);
    await configureQueue(memory);
    await withDiskWorker(memory, async (path) => {
      await storeGuest(memory, STATUS1, new Uint8Array([0xff]));
      await queueChain(memory, {
        head: 0,
        dataSlot: 1,
        statusSlot: 2,
        headerAddress: HEADER1,
        dataAddress: 0x400n, // outside the 512-byte guest RAM
        statusAddress: STATUS1,
        dataLength: 16,
        type: 1, // OUT
        sector: 0n,
        dataWritable: false,
      });
      await writeU16(memory, AVAIL_BASE + 2n, 1);
      await writeU16(memory, AVAIL_BASE + 4n, 0);
      await writeVirtioRegister(memory, 0x050n, 0);
      await waitForQueue(memory, async () => (await usedIdx(memory)) === 1);
      assert.equal((await loadGuest(memory, STATUS1, 1))[0], 1); // IOERR
      assert.equal(await readU32(memory, USED_BASE + 8n), 1);
      assert.deepEqual(readFileBytes(path).subarray(0, 16), SECTOR_HEAD); // no disk write
    });
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

describe('virtio disk capacity publication', () => {
  it('publishes capacity, leaving appearance to the host; the caller takes the wake baseline', async () => {
    const memory = createTestMemory(64n);
    initializeVirtio(memory, false);
    Atomics.store(virtioHostInt32(memory, VIRTIO_HOST_WAKE_SEQ), 0, 7);

    publishVirtioDiskCapacity(memory, 1280n);
    const handled = Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_WAKE_SEQ), 0) >>> 0;

    assert.equal(handled, 7);
    assert.equal(Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_WAKE_SEQ), 0), 7);
    assert.equal(loadVirtioDiskCapacity(memory), 1280n);
    assert.equal(loadVirtioDevicePresent(memory), 0);
    assert.equal(await readVirtioRegister(memory, 0x000n), 0);
    assert.equal(await readVirtioRegister(memory, 0x0fcn), 0);

    // The host publishes device-present only after observing readiness.
    storeVirtioDevicePresent(memory, true);
    assert.equal(loadVirtioDevicePresent(memory), 1);
    assert.equal(await readVirtioRegister(memory, 0x000n), 0x7472_6976);
    assert.equal(await readVirtioRegister(memory, 0x0fcn), 1);
    assert.equal(await readVirtioRegister(memory, 0x100n), 2);

    clearVirtioDiskCapacity(memory);
    assert.equal(loadVirtioDiskCapacity(memory), 0n);
  });
  it('withdraws exposed capacity without mutating a large capacity snapshot', async () => {
    const memory = createTestMemory(64n);
    const imageSize = 0x1234_5678_9abc_de00n;
    publishVirtioDiskCapacity(memory, imageSize);
    const expected = unsignedBigIntToBytes(new Uint8Array(8), imageSize / 512n);
    const capacity = new Uint8Array(8);
    await loadBytes({
      destination: capacity,
      memory,
      address: virtioAddress(0x100n),
      byteLength: 8,
    });
    assert.deepEqual(capacity, expected);

    // Withdraw after the first byte of one guest access. Remaining bytes must come
    // from the same readiness-gated snapshot, not from new per-byte readiness checks.
    const destination = new Proxy(capacity, {
      set: (target, property, value: unknown): boolean => {
        const stored = Reflect.set(target, property, value);
        if (property === '0') clearVirtioDiskCapacity(memory);
        return stored;
      },
    });
    loadBytesFromVirtio({
      destination,
      memory,
      address: virtioAddress(0x100n),
      offset: 0x100n,
      byteLength: 8,
    });
    assert.deepEqual(capacity, expected);
    assert.equal(Atomics.load(virtioHostInt32(memory, VIRTIO_HOST_DISK_CAPACITY_READY), 0), 0);
    assert.equal(loadVirtioDiskCapacity(memory), 0n);
    assert.equal(loadVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_LOW), 0x9abc_de00);
    assert.equal(loadVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH), 0x1234_5678);
    await loadBytes({
      destination: capacity,
      memory,
      address: virtioAddress(0x100n),
      byteLength: 8,
    });
    assert.deepEqual(capacity, new Uint8Array(8));
    clearVirtioDiskCapacity(memory); // withdrawal is idempotent, shadows remain intact
    assert.equal(loadVirtioShadowU32(memory, VIRTIO_HOST_DISK_CAPACITY_HIGH), 0x1234_5678);
  });
});
