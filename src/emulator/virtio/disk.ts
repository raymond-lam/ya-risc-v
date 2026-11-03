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

/** An open raw disk image: a structure with its file handle and image size in bytes. */
type VirtioDiskImage = {
  readonly fileHandle: FileHandle;
  readonly sizeBytes: number;
};

/** Close-once promises per image, so `closeVirtioDiskImage` is idempotent. */
const closePromises = new WeakMap<VirtioDiskImage, Promise<void>>();

/** Positional read into `destination`, looping over short reads; returns bytes read. */
const readDiskImageBytes = async ({
  image,
  position,
  destination,
}: {
  image: VirtioDiskImage;
  position: number;
  destination: Uint8Array;
}): Promise<number> => {
  let total = 0;
  while (total < destination.length) {
    const { bytesRead } = await image.fileHandle.read(
      destination,
      total,
      destination.length - total,
      position + total
    );
    if (bytesRead <= 0) {
      break;
    }
    total += bytesRead;
  }
  return total;
};

/** Positional write from `source`, looping over short writes; returns bytes written. */
const writeDiskImageBytes = async ({
  image,
  position,
  source,
}: {
  image: VirtioDiskImage;
  position: number;
  source: Uint8Array;
}): Promise<number> => {
  let total = 0;
  while (total < source.length) {
    const { bytesWritten } = await image.fileHandle.write(
      source,
      total,
      source.length - total,
      position + total
    );
    if (bytesWritten <= 0) {
      break;
    }
    total += bytesWritten;
  }
  return total;
};

/** Open a raw image read-write ('r+') and bind its handle and capacity to this structure. */
const openVirtioDiskImage = async (path: string): Promise<VirtioDiskImage> => {
  const fileHandle = await open(path, 'r+'); // ALWAYS 'r+' (constraint: no read-only mode)
  let sizeBytes: number;
  try {
    sizeBytes = (await fileHandle.stat()).size;
  } catch (error) {
    await fileHandle.close();
    throw error;
  }
  return { fileHandle, sizeBytes };
};

/** Close the image's file handle exactly once. */
const closeVirtioDiskImage = (image: VirtioDiskImage): Promise<void> => {
  let closePromise = closePromises.get(image);
  closePromise ??= image.fileHandle.close();
  return closePromise;
};

export { closeVirtioDiskImage, openVirtioDiskImage, readDiskImageBytes, writeDiskImageBytes };
export type { VirtioDiskImage };
