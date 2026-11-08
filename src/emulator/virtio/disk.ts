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
 *  The image size is a `bigint` so the u64 virtio-blk capacity is published exactly, never
 *  rounded through a `number`. Positions stay `number` (Node's positional `write()` types
 *  accept only `number`): exact file offsets therefore reach 2^53 bytes, far beyond any
 *  image this device can actually serve. */

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/** An open raw disk image: a structure with its file handle and image size in bytes. */
type DiskImage = {
  readonly fileHandle: FileHandle;
  readonly sizeBytes: bigint;
};

/** Close-once promises per image, so `closeDiskImage` is idempotent. */
const closePromises = new WeakMap<DiskImage, Promise<void>>();

/** Positional read into `destination`, looping over short reads; returns bytes read. */
const readDiskImageBytes = async ({
  image,
  position,
  destination,
}: {
  image: DiskImage;
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
  image: DiskImage;
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
const openDiskImage = async (path: string): Promise<DiskImage> => {
  const fileHandle = await open(path, 'r+'); // ALWAYS 'r+' (constraint: no read-only mode)
  let sizeBytes: bigint;
  try {
    // The bigint stat keeps the capacity exact above 2^53 bytes; a plain `number` size
    // would round and publish the wrong sector count to the guest.
    sizeBytes = (await fileHandle.stat({ bigint: true })).size;
  } catch (error) {
    await fileHandle.close();
    throw error;
  }
  return { fileHandle, sizeBytes };
};

/** Close the image's file handle exactly once. */
const closeDiskImage = (image: DiskImage): Promise<void> => {
  let closePromise = closePromises.get(image);
  if (closePromise === undefined) {
    closePromise = image.fileHandle.close();
    closePromises.set(image, closePromise);
  }
  return closePromise;
};

export { closeDiskImage, openDiskImage, readDiskImageBytes, writeDiskImageBytes };
export type { DiskImage };
