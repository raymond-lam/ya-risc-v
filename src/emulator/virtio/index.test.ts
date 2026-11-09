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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createVirtioDisk, initializeVirtio } from '#emulator/virtio';
import { loadVirtioDevicePresent, loadVirtioDiskCapacity } from '#emulator/virtio/registers';
import createTestMemory from '#test/guest-memory';

describe('virtio disk host lifecycle', () => {
  it(
    'opens and presents the disk before start resolves, separately from lifetime',
    { timeout: 5_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ya-risc-v-ready-'));
      const diskImagePath = join(dir, 'disk.img');
      writeFileSync(diskImagePath, new Uint8Array(1_024));
      const memory = createTestMemory(256n);
      initializeVirtio(memory, false);
      const disk = createVirtioDisk({ memory, diskImagePath });
      let joined = false;
      void disk.then(() => {
        joined = true;
      });
      try {
        const startup = disk.start();
        assert.throws(() => disk.start(), /Already started/);
        assert.equal(loadVirtioDevicePresent(memory), 0);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await startup;
        assert.equal(loadVirtioDevicePresent(memory), 1);
        assert.equal(loadVirtioDiskCapacity(memory), 1_024n);
        assert.equal(joined, false);
        const shutdown = disk.stop();
        assert.equal(disk.stop(), shutdown);
        await shutdown;
        assert.equal(joined, true);
        assert.throws(() => disk.start(), /Already stopped/);
      } finally {
        await disk.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it(
    'stop during image startup waits for readiness then joins the worker',
    { timeout: 5_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ya-risc-v-stop-ready-'));
      const diskImagePath = join(dir, 'disk.img');
      writeFileSync(diskImagePath, new Uint8Array(512));
      const memory = createTestMemory(256n);
      initializeVirtio(memory, false);
      const disk = createVirtioDisk({ memory, diskImagePath });
      try {
        const startup = disk.start();
        const shutdown = disk.stop();
        assert.equal(disk.stop(), shutdown);
        assert.throws(() => disk.start(), /Already stopped/);
        await startup;
        assert.equal(loadVirtioDevicePresent(memory), 1);
        await shutdown;
        await disk;
      } finally {
        await disk.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
