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

/** Positional asynchronous file operations for one raw virtio disk image.
 *  File offsets use JavaScript numbers, so images ≥ 2^53 bytes are out of scope. */

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/** An open image and its file-local capacity. */
type VirtioDiskImage = {
  readonly size: number;
  /** Positional read; short only at EOF. */
  read: (position: number, buffer: Uint8Array) => Promise<number>;
  /** Positional write; short only when the underlying file stops accepting bytes. */
  write: (position: number, buffer: Uint8Array) => Promise<number>;
  close: () => Promise<void>;
};

/** Positional read into `buffer`, looping over short reads; returns bytes read. */
const readDiskImage = async (
  handle: FileHandle,
  position: number,
  buffer: Uint8Array
): Promise<number> => {
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total);
    if (bytesRead <= 0) {
      break;
    }
    total += bytesRead;
  }
  return total;
};

/** Positional write from `buffer`, looping over short writes; returns bytes written. */
const writeDiskImage = async (
  handle: FileHandle,
  position: number,
  buffer: Uint8Array
): Promise<number> => {
  let total = 0;
  while (total < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      total,
      buffer.length - total,
      position + total
    );
    if (bytesWritten <= 0) {
      break;
    }
    total += bytesWritten;
  }
  return total;
};

/** Open a raw image read-write ('r+') and bind its handle and capacity to this instance. */
const openVirtioDiskImage = async (path: string): Promise<VirtioDiskImage> => {
  const handle = await open(path, 'r+'); // ALWAYS 'r+' (constraint: no read-only mode)
  let size: number;
  try {
    size = (await handle.stat()).size;
  } catch (error) {
    await handle.close();
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    size,
    read: (position, buffer) => readDiskImage(handle, position, buffer),
    write: (position, buffer) => writeDiskImage(handle, position, buffer),
    close: () => {
      closePromise ??= handle.close();
      return closePromise;
    },
  };
};

export { openVirtioDiskImage };
export type { VirtioDiskImage };
