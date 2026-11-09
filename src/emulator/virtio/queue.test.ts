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
import {
  atomicLoadReservedBytes,
  atomicStoreConditionalBytes,
  type Memory,
} from '#emulator/memory';
import { isPlicMachineExternalPending } from '#emulator/plic';
import {
  VIRTIO_HOST_QUEUE_EPOCH,
  VRING_DESC_F_NEXT,
  VRING_DESC_F_WRITE,
} from '#emulator/virtio/layout';
import { loadVirtioShadowU32 } from '#emulator/virtio/registers';
import { claimVirtioRequest, completeVirtioRequest } from '#emulator/virtio/queue';
import createTestMemory from '#test/guest-memory';
import {
  AVAIL_BASE,
  DATA1,
  DATA2,
  HEADER1,
  HEADER2,
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
  storeGuest,
  usedIdx,
  writeBlockHeader,
  writeDescriptor,
  writeU16,
  writeVirtioRegister,
} from '#test/virtio-queue';
import type { ChainSpec } from '#test/virtio-queue';

describe('virtio queue engine', () => {
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
    // Both type classes funnel into the same UNSUPP branch; queue them in one batch.
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
    await writeU16(memory, AVAIL_BASE + 4n, 0);
    await writeU16(memory, AVAIL_BASE + 6n, 3);
    await writeVirtioRegister(memory, 0x050n, 0);
    // Unit pump models worker consumption; notify never publishes by itself.
    await pumpUnitQueue(memory);
    assert.equal(await usedIdx(memory), 2);
    assert.equal((await loadGuest(memory, STATUS1, 1))[0], 2);
    assert.equal((await loadGuest(memory, STATUS2, 1))[0], 2);
    assert.equal(await readU32(memory, USED_BASE + 4n), 0);
    assert.equal(await readU32(memory, USED_BASE + 8n), 1);
    assert.equal(await readU32(memory, USED_BASE + 12n), 3);
    assert.equal(await readU32(memory, USED_BASE + 16n), 1);
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
    await queueChain(memory, {
      head: 3,
      dataSlot: 6,
      statusSlot: 7,
      headerAddress: HEADER1,
      dataAddress: DATA1,
      statusAddress: STATUS1,
      dataLength: 16,
      type: 0,
      sector: 0n,
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
    await writeBlockHeader(memory, 0, 1n);
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
});
