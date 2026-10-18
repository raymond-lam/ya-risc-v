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

/* eslint-disable import/prefer-default-export -- named export matches call-site style */

/**
 * Flattened device tree for the live guest map.
 * Built on each emulator start and copied into DRAM; `a1` receives its guest address.
 * Compatible strings are the ones OpenSBI's generic FDT drivers match.
 */

import { CLINT_REGION_ID } from '#emulator/clint';
import type { Memory } from '#emulator/memory';
import { PLIC_MAX_SOURCE, PLIC_REGION_ID, PLIC_SOURCE_UART } from '#emulator/plic';
import { copyIntoRam, RAM_REGION_ID } from '#emulator/ram';
import {
  SYSCON_POWEROFF_OFFSET,
  SYSCON_POWEROFF_VALUE,
  SYSCON_REBOOT_OFFSET,
  SYSCON_REBOOT_VALUE,
  SYSCON_REGION_ID,
} from '#emulator/syscon';
import { UART_REGION_ID } from '#emulator/uart';
import type { ReadonlyUint8Array } from '#types';
import { bytesToBigInt, unsignedBigIntToBytes } from '#utils/bytes';

type GuestWindow = {
  readonly guestAddress: ReadonlyUint8Array;
  readonly guestByteLength: bigint;
};

type FdtProperty = {
  name: string;
  value: Uint8Array;
};

type FdtNode = {
  name: string;
  properties: FdtProperty[];
  children: FdtNode[];
};

const FDT_MAGIC = 0xd00dfeed;
const FDT_BEGIN_NODE = 0x1;
const FDT_END_NODE = 0x2;
const FDT_PROP = 0x3;
const FDT_END = 0x9;
const FDT_VERSION = 17;
const FDT_LAST_COMP_VERSION = 16;
const FDT_HEADER_SIZE = 40;
const FDT_RESERVE_ENTRY_SIZE = 16;
const FDT_ALIGN = 8n;

/** `riscv,cpu-intc` phandle. CLINT and PLIC `interrupts-extended` point here. */
const PHANDLE_CPU_INTC = 1;
/** PLIC phandle. The UART `interrupt-parent` points here. */
const PHANDLE_PLIC = 2;
/** Syscon phandle. `syscon-poweroff` and `syscon-reboot` `regmap` point here. */
const PHANDLE_SYSCON = 3;

/** `regmap` update mask for a full 32-bit poweroff or reboot register. */
const SYSCON_REGISTER_MASK = 0xffff_ffff;

/** RISC-V interrupt causes the OpenSBI CLINT/PLIC parsers match. */
const IRQ_MACHINE_SOFTWARE = 3;
const IRQ_MACHINE_TIMER = 7;
const IRQ_SUPERVISOR_EXTERNAL = 9;
const IRQ_MACHINE_EXTERNAL = 11;

/**
 * 16550 clock and baud OpenSBI's uart8250 init programs. This UART ignores the divisor;
 * the properties are what the driver reads.
 */
const UART_CLOCK_HZ = 3_686_400;
const UART_BAUD = 115_200;

const PROP_COMPATIBLE = 'compatible';
const PROP_REG = 'reg';
const PROP_STATUS = 'status';
const PROP_DEVICE_TYPE = 'device_type';
const PROP_PHANDLE = 'phandle';
const PROP_INTERRUPTS_EXTENDED = 'interrupts-extended';
const PROP_INTERRUPT_CONTROLLER = 'interrupt-controller';
const PROP_INTERRUPT_CELLS = '#interrupt-cells';
const PROP_ADDRESS_CELLS = '#address-cells';
const PROP_SIZE_CELLS = '#size-cells';

/** Join byte arrays into one buffer. */
const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  let length = 0;
  for (const part of parts) {
    length += part.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

/** One big-endian 32-bit cell. FDT tokens and property cells use this byte order. */
const u32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};

/** NUL-terminated bytes. The extra byte is left 0. */
const cstring = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length + 1);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index);
  }
  return bytes;
};

/** Append zero bytes so the length is a multiple of 4. Node names and property values require this. */
const pad4 = (bytes: Uint8Array): Uint8Array => {
  const padding = (4 - (bytes.byteLength % 4)) % 4;
  if (padding === 0) {
    return bytes;
  }
  const padded = new Uint8Array(bytes.byteLength + padding);
  padded.set(bytes);
  return padded;
};

/** Consecutive big-endian u32 cells. */
const cells = (...values: readonly number[]): Uint8Array =>
  concat(values.map((value) => u32(value)));

/** `reg` as four big-endian cells: address high, address low, size high, size low. */
const reg64 = (address: bigint, size: bigint): Uint8Array =>
  cells(
    Number((address >> 32n) & 0xffff_ffffn),
    Number(address & 0xffff_ffffn),
    Number((size >> 32n) & 0xffff_ffffn),
    Number(size & 0xffff_ffffn)
  );

/** A property whose value bytes are already encoded. The name is resolved in the string block later. */
const property = (name: string, value: Uint8Array): FdtProperty => ({ name, value });

/** Guest window for `id`. Throws when that region is absent. */
const guestWindow = (guestRegions: ReadonlyMap<string, GuestWindow>, id: string): GuestWindow => {
  const region = guestRegions.get(id);
  if (region === undefined) {
    throw new RangeError(`Missing guest region '${id}'.`);
  }
  return region;
};

/** Hex unit address for a node name (`0x80000000` becomes `80000000`). */
const unitAddress = (address: bigint): string => address.toString(16);

/**
 * Hart 0 and its `riscv,cpu-intc` child.
 * `reg` is one big-endian cell (`/cpus` `#address-cells` is 1).
 */
const cpuNode = (): FdtNode => ({
  name: 'cpu@0',
  properties: [
    property(PROP_DEVICE_TYPE, cstring('cpu')),
    property(PROP_COMPATIBLE, cstring('riscv')),
    property(PROP_REG, u32(0)),
    property(PROP_STATUS, cstring('okay')),
    property('riscv,isa', cstring('rv64imacsu')),
  ],
  children: [
    {
      name: 'interrupt-controller',
      properties: [
        property(PROP_COMPATIBLE, cstring('riscv,cpu-intc')),
        property(PROP_INTERRUPT_CELLS, u32(1)),
        property(PROP_INTERRUPT_CONTROLLER, new Uint8Array(0)),
        property(PROP_PHANDLE, u32(PHANDLE_CPU_INTC)),
      ],
      children: [],
    },
  ],
});

/** CLINT node at `window`. `interrupts-extended` is machine software, then machine timer. */
const clintNode = (window: GuestWindow): FdtNode => {
  const address = bytesToBigInt(window.guestAddress);
  return {
    name: `clint@${unitAddress(address)}`,
    properties: [
      property(PROP_COMPATIBLE, concat([cstring('riscv,clint0'), cstring('sifive,clint0')])),
      property(PROP_REG, reg64(address, window.guestByteLength)),
      property(
        PROP_INTERRUPTS_EXTENDED,
        cells(PHANDLE_CPU_INTC, IRQ_MACHINE_SOFTWARE, PHANDLE_CPU_INTC, IRQ_MACHINE_TIMER)
      ),
    ],
    children: [],
  };
};

/** PLIC node at `window`. `interrupts-extended` is machine external, then supervisor external. */
const plicNode = (window: GuestWindow): FdtNode => {
  const address = bytesToBigInt(window.guestAddress);
  return {
    name: `plic@${unitAddress(address)}`,
    properties: [
      property(PROP_COMPATIBLE, concat([cstring('riscv,plic0'), cstring('sifive,plic-1.0.0')])),
      property(PROP_REG, reg64(address, window.guestByteLength)),
      property('riscv,ndev', u32(PLIC_MAX_SOURCE)),
      property(PROP_INTERRUPT_CELLS, u32(1)),
      property(PROP_ADDRESS_CELLS, u32(0)),
      property(PROP_INTERRUPT_CONTROLLER, new Uint8Array(0)),
      property(PROP_PHANDLE, u32(PHANDLE_PLIC)),
      property(
        PROP_INTERRUPTS_EXTENDED,
        cells(PHANDLE_CPU_INTC, IRQ_MACHINE_EXTERNAL, PHANDLE_CPU_INTC, IRQ_SUPERVISOR_EXTERNAL)
      ),
    ],
    children: [],
  };
};

/** One `syscon-poweroff` or `syscon-reboot` node bound to the syscon phandle. */
const sysconResetNode = (
  name: string,
  compatible: string,
  offset: number,
  value: number
): FdtNode => ({
  name,
  properties: [
    property(PROP_COMPATIBLE, cstring(compatible)),
    property('regmap', u32(PHANDLE_SYSCON)),
    property('offset', u32(offset)),
    property('value', u32(value)),
    property('mask', u32(SYSCON_REGISTER_MASK)),
  ],
  children: [],
});

/**
 * `syscon` node at `window`, with poweroff and reboot children.
 * OpenSBI's early reset drivers match the child compatible strings.
 */
const sysconNode = (window: GuestWindow): FdtNode => {
  const address = bytesToBigInt(window.guestAddress);
  return {
    name: `syscon@${unitAddress(address)}`,
    properties: [
      property(PROP_COMPATIBLE, cstring('syscon')),
      property(PROP_REG, reg64(address, window.guestByteLength)),
      property(PROP_PHANDLE, u32(PHANDLE_SYSCON)),
    ],
    children: [
      sysconResetNode('poweroff', 'syscon-poweroff', SYSCON_POWEROFF_OFFSET, SYSCON_POWEROFF_VALUE),
      sysconResetNode('reboot', 'syscon-reboot', SYSCON_REBOOT_OFFSET, SYSCON_REBOOT_VALUE),
    ],
  };
};

/**
 * ns16550a node at `window`.
 * `interrupt-parent` is included when `plic` is present.
 */
const uartNode = (window: GuestWindow, plic: GuestWindow | undefined): FdtNode => {
  const address = bytesToBigInt(window.guestAddress);
  const properties = [
    property(PROP_COMPATIBLE, cstring('ns16550a')),
    property(PROP_REG, reg64(address, window.guestByteLength)),
    property('clock-frequency', u32(UART_CLOCK_HZ)),
    property('current-speed', u32(UART_BAUD)),
    property('reg-shift', u32(0)),
    property('reg-io-width', u32(1)),
  ];
  if (plic !== undefined) {
    properties.push(
      property('interrupt-parent', u32(PHANDLE_PLIC)),
      property('interrupts', u32(PLIC_SOURCE_UART))
    );
  }
  return {
    name: `uart@${unitAddress(address)}`,
    properties,
    children: [],
  };
};

/**
 * Root node. `/cpus` is always present (`timebase-frequency` is one big-endian cell).
 * `/memory`, each `/soc` device, and `/chosen` are included for regions present in the map.
 */
const machineNode = (
  guestRegions: ReadonlyMap<string, GuestWindow>,
  timebaseHz: bigint
): FdtNode => {
  const ram = guestRegions.get(RAM_REGION_ID);
  const uart = guestRegions.get(UART_REGION_ID);
  const clint = guestRegions.get(CLINT_REGION_ID);
  const plic = guestRegions.get(PLIC_REGION_ID);
  const syscon = guestRegions.get(SYSCON_REGION_ID);
  const socChildren: FdtNode[] = [];
  if (clint !== undefined) {
    socChildren.push(clintNode(clint));
  }
  if (plic !== undefined) {
    socChildren.push(plicNode(plic));
  }
  if (uart !== undefined) {
    socChildren.push(uartNode(uart, plic));
  }
  if (syscon !== undefined) {
    socChildren.push(sysconNode(syscon));
  }
  const children: FdtNode[] = [
    {
      name: 'cpus',
      properties: [
        property(PROP_ADDRESS_CELLS, u32(1)),
        property(PROP_SIZE_CELLS, u32(0)),
        property('timebase-frequency', u32(Number(timebaseHz))),
      ],
      children: [cpuNode()],
    },
  ];
  if (ram !== undefined) {
    const ramAddress = bytesToBigInt(ram.guestAddress);
    children.push({
      name: `memory@${unitAddress(ramAddress)}`,
      properties: [
        property(PROP_DEVICE_TYPE, cstring('memory')),
        property(PROP_REG, reg64(ramAddress, ram.guestByteLength)),
      ],
      children: [],
    });
  }
  if (socChildren.length > 0) {
    children.push({
      name: 'soc',
      properties: [
        property(PROP_ADDRESS_CELLS, u32(2)),
        property(PROP_SIZE_CELLS, u32(2)),
        property(PROP_COMPATIBLE, cstring('simple-bus')),
        property('ranges', new Uint8Array(0)),
      ],
      children: socChildren,
    });
  }
  if (uart !== undefined) {
    const uartAddress = bytesToBigInt(uart.guestAddress);
    children.push({
      name: 'chosen',
      properties: [property('stdout-path', cstring(`/soc/uart@${unitAddress(uartAddress)}`))],
      children: [],
    });
  }
  return {
    name: '',
    properties: [
      property(PROP_ADDRESS_CELLS, u32(2)),
      property(PROP_SIZE_CELLS, u32(2)),
      property(PROP_COMPATIBLE, cstring('ya-risc-v')),
      property('model', cstring('ya-risc-v')),
    ],
    children,
  };
};

/** Property names in tree order, each name once. */
const collectNames = (node: FdtNode, names: string[]): void => {
  for (const prop of node.properties) {
    if (!names.includes(prop.name)) {
      names.push(prop.name);
    }
  }
  for (const child of node.children) {
    collectNames(child, names);
  }
};

/** Property names as consecutive C strings, with each name's byte offset into that block. */
const stringBlock = (
  names: readonly string[]
): { bytes: Uint8Array; offsetOf: ReadonlyMap<string, number> } => {
  const parts: Uint8Array[] = [];
  const offsetOf = new Map<string, number>();
  let offset = 0;
  for (const name of names) {
    offsetOf.set(name, offset);
    const encoded = cstring(name);
    parts.push(encoded);
    offset += encoded.byteLength;
  }
  return { bytes: concat(parts), offsetOf };
};

/**
 * Append `BEGIN_NODE`, the padded name, properties, children, and `END_NODE`.
 * Tokens, value lengths, and string offsets are big-endian u32s.
 */
const emitNode = (
  node: FdtNode,
  offsetOf: ReadonlyMap<string, number>,
  parts: Uint8Array[]
): void => {
  parts.push(u32(FDT_BEGIN_NODE), pad4(cstring(node.name)));
  for (const prop of node.properties) {
    const nameOffset = offsetOf.get(prop.name);
    if (nameOffset === undefined) {
      throw new Error(`Missing device tree string '${prop.name}'.`);
    }
    parts.push(u32(FDT_PROP), u32(prop.value.byteLength), u32(nameOffset), pad4(prop.value));
  }
  for (const child of node.children) {
    emitNode(child, offsetOf, parts);
  }
  parts.push(u32(FDT_END_NODE));
};

/** Version-17 blob: big-endian header, empty memory-reserve map, struct block, strings block. */
const flatten = (root: FdtNode): Uint8Array => {
  const names: string[] = [];
  collectNames(root, names);
  const strings = stringBlock(names);
  const structParts: Uint8Array[] = [];
  emitNode(root, strings.offsetOf, structParts);
  structParts.push(u32(FDT_END));
  const struct = concat(structParts);
  const offMemRsvmap = FDT_HEADER_SIZE;
  const offDtStruct = offMemRsvmap + FDT_RESERVE_ENTRY_SIZE;
  const offDtStrings = offDtStruct + struct.byteLength;
  const totalSize = offDtStrings + strings.bytes.byteLength;
  return concat([
    concat([
      u32(FDT_MAGIC),
      u32(totalSize),
      u32(offDtStruct),
      u32(offDtStrings),
      u32(offMemRsvmap),
      u32(FDT_VERSION),
      u32(FDT_LAST_COMP_VERSION),
      u32(0),
      u32(strings.bytes.byteLength),
      u32(struct.byteLength),
    ]),
    new Uint8Array(FDT_RESERVE_ENTRY_SIZE),
    struct,
    strings.bytes,
  ]);
};

/** Encode a DTB whose `reg` windows and `timebase-frequency` come from the caller. */
const encodeDeviceTree = (
  guestRegions: ReadonlyMap<string, GuestWindow>,
  timebaseHz: bigint
): Uint8Array => flatten(machineNode(guestRegions, timebaseHz));

/** Round `value` down to a multiple of `alignment`. `alignment` is a power of two. */
const alignDown = (value: bigint, alignment: bigint): bigint => value & ~(alignment - 1n);

/**
 * Where to store the device tree.
 * `'end'` is the top of the RAM window. `null` stores no blob.
 * A byte buffer is that guest physical address.
 */
type DeviceTreeAddress = 'end' | ReadonlyUint8Array | null;

/**
 * Copy a device tree for `guestRegions` into RAM at `deviceTreeAddress`.
 * Returns that guest address as 8 little-endian bytes. The blob bytes stay big-endian.
 */
const storeDeviceTreeToRam = (
  memory: Memory,
  guestRegions: ReadonlyMap<string, GuestWindow>,
  imageByteLength: number,
  timebaseHz: bigint,
  deviceTreeAddress: Exclude<DeviceTreeAddress, null>
): ReadonlyUint8Array => {
  const ram = guestWindow(guestRegions, RAM_REGION_ID);
  const blob = encodeDeviceTree(guestRegions, timebaseHz);
  const base = bytesToBigInt(ram.guestAddress);
  const address =
    deviceTreeAddress === 'end'
      ? alignDown(base + ram.guestByteLength - BigInt(blob.byteLength), FDT_ALIGN)
      : bytesToBigInt(deviceTreeAddress);
  if (deviceTreeAddress !== 'end' && address % FDT_ALIGN !== 0n) {
    throw new RangeError('device tree address must be 8-byte aligned.');
  }
  if (
    address < base + BigInt(imageByteLength) ||
    address + BigInt(blob.byteLength) > base + ram.guestByteLength
  ) {
    throw new RangeError(
      `device tree (${blob.byteLength} bytes) does not fit in the ram region above the image (${imageByteLength} bytes).`
    );
  }
  const storedAddress = unsignedBigIntToBytes(new Uint8Array(8), address) as ReadonlyUint8Array;
  copyIntoRam(memory, storedAddress, blob);
  return storedAddress;
};

export { storeDeviceTreeToRam };
export type { DeviceTreeAddress };
