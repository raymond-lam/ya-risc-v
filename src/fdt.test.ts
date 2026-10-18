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
import { CLINT_GUEST_BYTE_LENGTH, CLINT_REGION_ID } from '#emulator/clint';
import { createMemory, loadBytes } from '#emulator/memory';
import {
  PLIC_GUEST_BYTE_LENGTH,
  PLIC_MAX_SOURCE,
  PLIC_REGION_ID,
  PLIC_SOURCE_UART,
} from '#emulator/plic';
import { RAM_REGION_ID } from '#emulator/ram';
import {
  SYSCON_GUEST_BYTE_LENGTH,
  SYSCON_POWEROFF_OFFSET,
  SYSCON_POWEROFF_VALUE,
  SYSCON_REBOOT_OFFSET,
  SYSCON_REBOOT_VALUE,
  SYSCON_REGION_ID,
} from '#emulator/syscon';
import { UART_GUEST_BYTE_LENGTH, UART_REGION_ID } from '#emulator/uart';
import { storeDeviceTreeToRam, type DeviceTreeAddress } from '#fdt';
import { machineRegionSpecs } from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { bytesToBigInt, unsignedBigIntToBytes } from '#utils/bytes';

const FDT_BEGIN_NODE = 0x1;
const FDT_END_NODE = 0x2;
const FDT_PROP = 0x3;
const FDT_END = 0x9;

type DecodedNode = {
  name: string;
  properties: Map<string, Uint8Array>;
  children: DecodedNode[];
};

const guest = (address: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), address) as ReadonlyUint8Array;

const regionsFor = ({
  ramBase,
  ramSize,
  uartBase,
  clintBase,
  plicBase,
  sysconBase,
}: {
  ramBase: bigint;
  ramSize: bigint;
  uartBase: bigint;
  clintBase: bigint;
  plicBase: bigint;
  sysconBase?: bigint;
}): Map<string, { guestAddress: ReadonlyUint8Array; guestByteLength: bigint }> => {
  const regions = new Map<string, { guestAddress: ReadonlyUint8Array; guestByteLength: bigint }>([
    [RAM_REGION_ID, { guestAddress: guest(ramBase), guestByteLength: ramSize }],
    [UART_REGION_ID, { guestAddress: guest(uartBase), guestByteLength: UART_GUEST_BYTE_LENGTH }],
    [CLINT_REGION_ID, { guestAddress: guest(clintBase), guestByteLength: CLINT_GUEST_BYTE_LENGTH }],
    [PLIC_REGION_ID, { guestAddress: guest(plicBase), guestByteLength: PLIC_GUEST_BYTE_LENGTH }],
  ]);
  if (sysconBase !== undefined) {
    regions.set(SYSCON_REGION_ID, {
      guestAddress: guest(sysconBase),
      guestByteLength: SYSCON_GUEST_BYTE_LENGTH,
    });
  }
  return regions;
};

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const readU32 = (bytes: Uint8Array, offset: number): number =>
  viewOf(bytes).getUint32(offset, false);

const align4 = (offset: number): number => (offset + 3) & ~3;

const readName = (bytes: Uint8Array, offset: number): { name: string; next: number } => {
  let end = offset;
  while (bytes[end] !== 0) {
    end += 1;
  }
  return {
    name: new TextDecoder().decode(bytes.subarray(offset, end)),
    next: align4(end + 1),
  };
};

const readString = (bytes: Uint8Array, offset: number): string => {
  let end = offset;
  while (bytes[end] !== 0) {
    end += 1;
  }
  return new TextDecoder().decode(bytes.subarray(offset, end));
};

const decodeNode = (
  blob: Uint8Array,
  stringsOffset: number,
  offset: number
): { node: DecodedNode; next: number } => {
  assert.equal(readU32(blob, offset), FDT_BEGIN_NODE);
  const name = readName(blob, offset + 4);
  const node: DecodedNode = { name: name.name, properties: new Map(), children: [] };
  let cursor = name.next;
  for (;;) {
    const token = readU32(blob, cursor);
    if (token === FDT_PROP) {
      const length = readU32(blob, cursor + 4);
      const nameOffset = readU32(blob, cursor + 8);
      const value = blob.slice(cursor + 12, cursor + 12 + length);
      node.properties.set(readString(blob, stringsOffset + nameOffset), value);
      cursor = align4(cursor + 12 + length);
    } else if (token === FDT_BEGIN_NODE) {
      const child = decodeNode(blob, stringsOffset, cursor);
      node.children.push(child.node);
      cursor = child.next;
    } else if (token === FDT_END_NODE) {
      return { node, next: cursor + 4 };
    } else {
      assert.fail(`unexpected device tree token ${token}`);
    }
  }
};

const ramMemory = (
  regions: Map<string, { guestAddress: ReadonlyUint8Array; guestByteLength: bigint }>
): ReturnType<typeof createMemory> => {
  const ram = regions.get(RAM_REGION_ID);
  assert.ok(ram !== undefined);
  return createMemory([
    {
      id: RAM_REGION_ID,
      hostByteLength: ram.guestByteLength,
      guestAddress: ram.guestAddress,
      guestByteLength: ram.guestByteLength,
    },
  ]);
};

/** Store the tree and read the blob back from the guest address `storeDeviceTreeToRam` returns. */
const storedBlob = (
  regions: Map<string, { guestAddress: ReadonlyUint8Array; guestByteLength: bigint }>,
  timebaseHz: bigint,
  imageByteLength = 0,
  memory = ramMemory(regions),
  deviceTreeAddress: Exclude<DeviceTreeAddress, null> = 'end'
): { address: ReadonlyUint8Array; blob: Uint8Array } => {
  const address = storeDeviceTreeToRam(
    memory,
    regions,
    imageByteLength,
    timebaseHz,
    deviceTreeAddress
  );
  const header = loadBytes({
    destination: new Uint8Array(8),
    memory,
    address,
    byteLength: 8,
  });
  const totalSize = readU32(header, 4);
  return {
    address,
    blob: loadBytes({
      destination: new Uint8Array(totalSize),
      memory,
      address,
      byteLength: totalSize,
    }),
  };
};

const decode = (blob: Uint8Array): DecodedNode => {
  assert.equal(readU32(blob, 0), 0xd00dfeed);
  const structOffset = readU32(blob, 8);
  const stringsOffset = readU32(blob, 12);
  const decoded = decodeNode(blob, stringsOffset, structOffset);
  assert.equal(readU32(blob, decoded.next), FDT_END);
  return decoded.node;
};

const child = (node: DecodedNode, name: string): DecodedNode => {
  const found = node.children.find((entry) => entry.name === name);
  assert.ok(found !== undefined, name);
  return found;
};

const text = (node: DecodedNode, name: string): string => {
  const value = node.properties.get(name);
  assert.ok(value !== undefined, name);
  return new TextDecoder().decode(value.subarray(0, value.indexOf(0)));
};

const stringList = (node: DecodedNode, name: string): string[] => {
  const value = node.properties.get(name);
  assert.ok(value !== undefined, name);
  const strings: string[] = [];
  let start = 0;
  for (let index = 0; index < value.byteLength; index += 1) {
    if (value[index] === 0) {
      strings.push(new TextDecoder().decode(value.subarray(start, index)));
      start = index + 1;
    }
  }
  return strings;
};

const cells = (node: DecodedNode, name: string): number[] => {
  const value = node.properties.get(name);
  assert.ok(value !== undefined, name);
  const view = viewOf(value);
  const words: number[] = [];
  for (let offset = 0; offset < value.byteLength; offset += 4) {
    words.push(view.getUint32(offset, false));
  }
  return words;
};

const reg = (node: DecodedNode): { address: bigint; size: bigint } => {
  const words = cells(node, 'reg');
  assert.equal(words.length, 4);
  const word = (index: number): bigint => BigInt(words[index] ?? 0);
  return {
    address: (word(0) << 32n) | word(1),
    size: (word(2) << 32n) | word(3),
  };
};

const virt = regionsFor({
  ramBase: 0x8000_0000n,
  ramSize: 0x1000_0000n,
  uartBase: 0x1000_0000n,
  clintBase: 0x0200_0000n,
  plicBase: 0x0c00_0000n,
  sysconBase: 0x0010_0000n,
});

describe('storeDeviceTreeToRam', () => {
  it('describes the virt-like map with OpenSBI compatible strings', () => {
    const root = decode(storedBlob(virt, 10_000_000n).blob);
    const memory = child(root, 'memory@80000000');
    assert.equal(text(memory, 'device_type'), 'memory');
    assert.deepEqual(reg(memory), { address: 0x8000_0000n, size: 0x1000_0000n });

    const cpuIntc = child(child(child(root, 'cpus'), 'cpu@0'), 'interrupt-controller');
    assert.ok(stringList(cpuIntc, 'compatible').includes('riscv,cpu-intc'));
    assert.equal(cells(child(root, 'cpus'), 'timebase-frequency')[0], 10_000_000);

    const soc = child(root, 'soc');
    const clint = child(soc, 'clint@2000000');
    assert.ok(stringList(clint, 'compatible').includes('riscv,clint0'));
    assert.deepEqual(reg(clint), { address: 0x0200_0000n, size: CLINT_GUEST_BYTE_LENGTH });
    assert.deepEqual(cells(clint, 'interrupts-extended'), [1, 3, 1, 7]);

    const plic = child(soc, 'plic@c000000');
    assert.ok(stringList(plic, 'compatible').includes('riscv,plic0'));
    assert.deepEqual(reg(plic), { address: 0x0c00_0000n, size: PLIC_GUEST_BYTE_LENGTH });
    assert.equal(cells(plic, 'riscv,ndev')[0], PLIC_MAX_SOURCE);
    assert.deepEqual(cells(plic, 'interrupts-extended'), [1, 11, 1, 9]);

    const uart = child(soc, 'uart@10000000');
    assert.ok(stringList(uart, 'compatible').includes('ns16550a'));
    assert.deepEqual(reg(uart), { address: 0x1000_0000n, size: UART_GUEST_BYTE_LENGTH });
    assert.equal(cells(uart, 'interrupts')[0], PLIC_SOURCE_UART);

    const syscon = child(soc, 'syscon@100000');
    assert.ok(stringList(syscon, 'compatible').includes('syscon'));
    assert.deepEqual(reg(syscon), { address: 0x0010_0000n, size: SYSCON_GUEST_BYTE_LENGTH });
    assert.equal(cells(syscon, 'phandle')[0], 3);
    const poweroff = child(syscon, 'poweroff');
    assert.ok(stringList(poweroff, 'compatible').includes('syscon-poweroff'));
    assert.equal(cells(poweroff, 'regmap')[0], 3);
    assert.equal(cells(poweroff, 'offset')[0], SYSCON_POWEROFF_OFFSET);
    assert.equal(cells(poweroff, 'value')[0], SYSCON_POWEROFF_VALUE);
    assert.equal(cells(poweroff, 'mask')[0], 0xffff_ffff);
    const reboot = child(syscon, 'reboot');
    assert.ok(stringList(reboot, 'compatible').includes('syscon-reboot'));
    assert.equal(cells(reboot, 'offset')[0], SYSCON_REBOOT_OFFSET);
    assert.equal(cells(reboot, 'value')[0], SYSCON_REBOOT_VALUE);

    assert.equal(text(child(root, 'chosen'), 'stdout-path'), '/soc/uart@10000000');
  });

  it('follows a shifted guest map', () => {
    const root = decode(
      storedBlob(
        regionsFor({
          ramBase: 0x9000_0000n,
          ramSize: 0x2000n,
          uartBase: 0x4000_0000n,
          clintBase: 0x5000_0000n,
          plicBase: 0x6000_0000n,
        }),
        1_000_000n
      ).blob
    );
    assert.deepEqual(reg(child(root, 'memory@90000000')), {
      address: 0x9000_0000n,
      size: 0x2000n,
    });
    assert.equal(text(child(root, 'chosen'), 'stdout-path'), '/soc/uart@40000000');
    assert.equal(reg(child(child(root, 'soc'), 'uart@40000000')).address, 0x4000_0000n);
    assert.equal(cells(child(root, 'cpus'), 'timebase-frequency')[0], 1_000_000);
  });

  it('includes only the regions present in the map', () => {
    const ramAndUart = new Map([
      [RAM_REGION_ID, { guestAddress: guest(0x8000_0000n), guestByteLength: 0x1_0000n }],
      [
        UART_REGION_ID,
        { guestAddress: guest(0x1000_0000n), guestByteLength: UART_GUEST_BYTE_LENGTH },
      ],
    ]);
    const root = decode(storedBlob(ramAndUart, 10_000_000n).blob);
    const soc = child(root, 'soc');
    assert.deepEqual(
      soc.children.map((node) => node.name),
      ['uart@10000000']
    );
    const uart = child(soc, 'uart@10000000');
    assert.equal(uart.properties.has('interrupt-parent'), false);
    assert.equal(uart.properties.has('interrupts'), false);
    assert.equal(text(child(root, 'chosen'), 'stdout-path'), '/soc/uart@10000000');

    const ramOnly = new Map([
      [RAM_REGION_ID, { guestAddress: guest(0x8000_0000n), guestByteLength: 0x1_0000n }],
    ]);
    const bare = decode(storedBlob(ramOnly, 10_000_000n).blob);
    assert.deepEqual(
      bare.children.map((node) => node.name),
      ['cpus', 'memory@80000000']
    );
  });

  it('copies the blob to the top of RAM above the image', () => {
    const ramSize = 0x1_0000n;
    const regions = regionsFor({
      ramBase: 0x8000_0000n,
      ramSize,
      uartBase: 0x1000_0000n,
      clintBase: 0x0200_0000n,
      plicBase: 0x0c00_0000n,
    });
    const memory = createMemory(
      machineRegionSpecs({
        ramBaseAddress: guest(0x8000_0000n),
        ramSize,
        uartBaseAddress: guest(0x1000_0000n),
        clintBaseAddress: guest(0x0200_0000n),
        plicBaseAddress: guest(0x0c00_0000n),
      })
    );
    const image = Uint8Array.of(0x73, 0x00, 0x50, 0x10);
    memory.bytes.set(image, 0);

    const { address, blob } = storedBlob(regions, 10_000_000n, image.byteLength, memory);
    const addressValue = bytesToBigInt(address);
    assert.equal(addressValue % 8n, 0n);
    assert.ok(addressValue >= 0x8000_0000n + BigInt(image.byteLength));
    assert.ok(addressValue + BigInt(blob.byteLength) <= 0x8000_0000n + ramSize);
    assert.equal(readU32(blob, 0), 0xd00dfeed);
    assert.deepEqual(memory.bytes.subarray(0, image.byteLength), image);
  });

  it('rejects a RAM window that cannot hold the image and the blob', () => {
    const regions = regionsFor({
      ramBase: 0x8000_0000n,
      ramSize: 64n,
      uartBase: 0x1000_0000n,
      clintBase: 0x0200_0000n,
      plicBase: 0x0c00_0000n,
    });
    const memory = createMemory(
      machineRegionSpecs({
        ramBaseAddress: guest(0x8000_0000n),
        ramSize: 64n,
        uartBaseAddress: guest(0x1000_0000n),
        clintBaseAddress: guest(0x0200_0000n),
        plicBaseAddress: guest(0x0c00_0000n),
      })
    );
    assert.throws(() => storeDeviceTreeToRam(memory, regions, 64, 10_000_000n, 'end'), {
      name: 'RangeError',
      message: /does not fit in the ram region/,
    });
  });

  it('stores the blob at a caller-supplied address', () => {
    const regions = regionsFor({
      ramBase: 0x8000_0000n,
      ramSize: 0x1_0000n,
      uartBase: 0x1000_0000n,
      clintBase: 0x0200_0000n,
      plicBase: 0x0c00_0000n,
    });
    const address = guest(0x8000_1000n);
    const stored = storedBlob(regions, 10_000_000n, 0, ramMemory(regions), address);
    assert.deepEqual(stored.address, address);
    assert.equal(readU32(stored.blob, 0), 0xd00dfeed);
  });

  it('rejects a device tree address that is not 8-byte aligned', () => {
    const regions = regionsFor({
      ramBase: 0x8000_0000n,
      ramSize: 0x1_0000n,
      uartBase: 0x1000_0000n,
      clintBase: 0x0200_0000n,
      plicBase: 0x0c00_0000n,
    });
    assert.throws(
      () => storeDeviceTreeToRam(ramMemory(regions), regions, 0, 10_000_000n, guest(0x8000_1004n)),
      { name: 'RangeError', message: /8-byte aligned/ }
    );
  });
});
