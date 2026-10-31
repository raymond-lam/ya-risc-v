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
 * Guest load/store dispatch for the dense VirtIO-MMIO register window.
 */

import type { Memory } from '#emulator/memory';
import type { ReadonlyUint8Array } from '#types';
import { loadVirtioRegisterByte, storeVirtioRegister } from '#emulator/virtio/registers';
import { VIRTIO_GUEST_BYTE_LENGTH } from '#emulator/virtio/region';

/** Guest load of VirtIO register bytes starting at `offset`. */
const loadBytesFromVirtio = ({
  destination,
  memory,
  offset,
  byteLength,
}: {
  destination: Uint8Array;
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  byteLength: number;
}): void => {
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    const registerIndex = Number(offset) + byteIndex;
    destination[byteIndex] =
      registerIndex >= 0 && registerIndex < Number(VIRTIO_GUEST_BYTE_LENGTH)
        ? loadVirtioRegisterByte(memory, registerIndex)
        : 0;
  }
};

/** Guest store of VirtIO register bytes starting at `offset`. */
const storeBytesToVirtio = ({
  memory,
  offset,
  source,
  byteLength,
}: {
  memory: Memory;
  address: ReadonlyUint8Array;
  offset: bigint;
  source: ReadonlyUint8Array;
  byteLength: number;
}): void => {
  if (offset < 0n || offset >= VIRTIO_GUEST_BYTE_LENGTH) {
    return;
  }
  const registerIndex = Number(offset);
  if (
    registerIndex === 0x44 ||
    registerIndex === 0x50 ||
    registerIndex === 0x64 ||
    registerIndex === 0x70
  ) {
    storeVirtioRegister(memory, registerIndex, source);
    return;
  }
  if (byteLength !== 4) {
    return;
  }
  storeVirtioRegister(memory, registerIndex, source);
};

export { loadBytesFromVirtio, storeBytesToVirtio };
