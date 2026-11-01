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
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

/** Run the CLI and keep its output. A thrown guest-setup error exits non-zero. */
const runCli = (args: readonly string[]): Promise<{ stderr: string; exitCode: number }> =>
  new Promise((resolve) => {
    execFile(
      tsx,
      ['--conditions', '@ya-risc-v/source', 'src/index.ts', ...args],
      { cwd: root, encoding: 'utf8', timeout: 20_000 },
      (error, _stdout, stderr) => {
        let exitCode = 0;
        if (error !== null && typeof error.code === 'number') {
          exitCode = error.code;
        } else if (error !== null) {
          exitCode = 1;
        }
        resolve({
          stderr: typeof stderr === 'string' ? stderr : '',
          exitCode,
        });
      }
    );
  });

describe('cli', () => {
  it('passes --timebase-frequency through to emulator setup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ya-risc-v-'));
    const image = join(directory, 'image.bin');
    await writeFile(image, Uint8Array.of(0x00));
    try {
      const result = await runCli(['--ram-size', '64', '--timebase-frequency', '12345', image]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /does not fit in the ram region/);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('maps the virtio window at the default 0x10001000 base', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ya-risc-v-'));
    const image = join(directory, 'image.bin');
    await writeFile(image, Uint8Array.of(0x00));
    try {
      // The 8-byte UART window at 0x10001000 lands inside the default virtio window.
      const result = await runCli(['--ram-size', '64', '--uart-base', '0x10001000', image]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /uart window overlaps virtio/);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('honors a --virtio-base override in the guest map', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ya-risc-v-'));
    const image = join(directory, 'image.bin');
    await writeFile(image, Uint8Array.of(0x00));
    try {
      // Overriding the virtio base onto the PLIC base proves the flag reached the map.
      const result = await runCli(['--ram-size', '64', '--virtio-base', '0x0c000000', image]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /plic window overlaps virtio/);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('accepts a non-overlapping --virtio-base override', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ya-risc-v-'));
    const image = join(directory, 'image.bin');
    await writeFile(image, Uint8Array.of(0x00));
    try {
      const result = await runCli(['--ram-size', '64', '--virtio-base', '0x10002000', image]);
      assert.equal(result.exitCode, 1);
      // Reached emulator setup and failed for the pre-existing reason, not a virtio error.
      assert.match(result.stderr, /does not fit in the ram region/);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('rejects a --disk-image path that cannot be opened read-write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ya-risc-v-'));
    const image = join(directory, 'image.bin');
    const disk = join(directory, 'missing.img');
    await writeFile(image, Uint8Array.of(0x00));
    try {
      const result = await runCli(['--ram-size', '64', '--disk-image', disk, image]);
      assert.equal(result.exitCode, 1);
      assert.match(
        result.stderr,
        /--disk-image '.*missing\.img' must be an existing file openable for read-write access/
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('rejects a read-only --disk-image file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ya-risc-v-'));
    const image = join(directory, 'image.bin');
    const disk = join(directory, 'disk.img');
    await writeFile(image, Uint8Array.of(0x00));
    await writeFile(disk, Uint8Array.of(0x00));
    await chmod(disk, 0o444);
    try {
      if (process.getuid !== undefined && process.getuid() === 0) {
        // Root ignores the file mode, so the EACCES path is not observable as root.
        return;
      }
      const result = await runCli(['--ram-size', '64', '--disk-image', disk, image]);
      assert.equal(result.exitCode, 1);
      assert.match(
        result.stderr,
        /--disk-image '.*disk\.img' must be an existing file openable for read-write access/
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('accepts a writable --disk-image path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ya-risc-v-'));
    const image = join(directory, 'image.bin');
    const disk = join(directory, 'disk.img');
    await writeFile(image, Uint8Array.of(0x00));
    await writeFile(disk, Uint8Array.of(0x00));
    try {
      const result = await runCli(['--ram-size', '64', '--disk-image', disk, image]);
      assert.equal(result.exitCode, 1);
      // Validation passed; setup failed for the pre-existing reason.
      assert.match(result.stderr, /does not fit in the ram region/);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('treats --disk-image as optional', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ya-risc-v-'));
    const image = join(directory, 'image.bin');
    await writeFile(image, Uint8Array.of(0x00));
    try {
      const result = await runCli(['--ram-size', '64', image]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /does not fit in the ram region/);
      assert.doesNotMatch(result.stderr, /--disk-image/);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
