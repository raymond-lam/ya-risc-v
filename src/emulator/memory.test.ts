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
  CLINT_REGION_ID,
  isClintMachineSoftwarePending,
  isClintMachineTimerPending,
} from '#emulator/clint';
import { IRQ_LEVEL_REGION_ID } from '#emulator/irq-level';
import {
  atomicCompareExchangeBytes,
  atomicLoadBytes,
  atomicStoreBytes,
  createMemory,
  loadBytes,
  storeBytes,
  type Memory,
} from '#emulator/memory';
import {
  isPlicMachineExternalPending,
  PLIC_REGION_ID,
  PLIC_SOURCE_UART,
  setPlicSourcePending,
} from '#emulator/plic';
import { RAM_REGION_ID } from '#emulator/ram';
import { RESERVATION_REGION_ID } from '#emulator/reservation';
import { popUartTransmit, pushUartReceive, UART_REGION_ID } from '#emulator/uart';
import { bigIntAsNumber } from '#utils/int';
import createTestMemory, { machineRegionSpecs } from '#test/guest-memory';
import type { ReadonlyUint8Array } from '#types';
import { compareUnsignedBytes, signedNumberToBytes, unsignedBigIntToBytes } from '#utils/bytes';

/** Snapshot the irq-level Int32 (test observation only). */
const readIrqLevel = (memory: Memory): number => {
  const region = memory.regions.get(IRQ_LEVEL_REGION_ID);
  assert.ok(region);
  return Atomics.load(new Int32Array(memory.bytes.buffer, bigIntAsNumber(region.hostIndex), 1), 0);
};

/** Host offset of the UART TX-wake Int32 (matches `#emulator/uart/region`). */
const UART_TX_WAKE_HOST_OFFSET = 44;

/** Snapshot the UART TX wake Int32 (test observation only). */
const readUartTxWake = (memory: Memory): number => {
  const region = memory.regions.get(UART_REGION_ID);
  assert.ok(region);
  return Atomics.load(
    new Int32Array(
      memory.bytes.buffer,
      bigIntAsNumber(region.hostIndex) + UART_TX_WAKE_HOST_OFFSET,
      1
    ),
    0
  );
};

/** IRQ level bits — local to tests (match `#emulator/irq-level`). */
const IRQ_LEVEL_MSIP = 1 << 3;
const IRQ_LEVEL_MEIP = 1 << 11;

/** LSR bits — local to tests (not part of the public UART surface). */
const LSR_DR = 0x01;
const LSR_THRE = 0x20;
const LSR_TEMT = 0x40;

/** CLINT register offsets relative to base — local to tests. */
const CLINT_MTIMECMP_OFFSET = 0x4000n;
const CLINT_MTIME_OFFSET = 0xbff8n;

const RAM_BASE = new Uint8Array(8) as ReadonlyUint8Array;
const UART_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x1000_0000n) as ReadonlyUint8Array;
const CLINT_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x0200_0000n) as ReadonlyUint8Array;
const PLIC_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x0c00_0000n) as ReadonlyUint8Array;
const HIGH_RAM_BASE = unsignedBigIntToBytes(new Uint8Array(8), 0x8000_0000n) as ReadonlyUint8Array;

const guest = (address: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), address) as ReadonlyUint8Array;

const uartAddress = (registerIndex: number): ReadonlyUint8Array => {
  const address = new Uint8Array(UART_BASE);
  address[0] = (address[0]! + registerIndex) & 0xff;
  return address as ReadonlyUint8Array;
};

const plicAddress = (offset: bigint): ReadonlyUint8Array =>
  unsignedBigIntToBytes(new Uint8Array(8), 0x0c00_0000n + offset);

const storePlicUint32 = (memory: Memory, offset: bigint, value: number): void => {
  storeBytes({
    memory,
    address: plicAddress(offset),
    source: unsignedBigIntToBytes(new Uint8Array(8), BigInt(value >>> 0)),
    byteLength: 4,
  });
};

const loadPlicUint32 = (memory: Memory, offset: bigint): number => {
  const destination = new Uint8Array(8);
  loadBytes({
    destination,
    memory,
    address: plicAddress(offset),
    byteLength: 4,
  });
  return (
    destination[0]! | (destination[1]! << 8) | (destination[2]! << 16) | (destination[3]! << 24)
  );
};

/** Arm M-context for UART, then assert/clear the device pending bit. */
const setUartPlicPending = (memory: Memory, pending: boolean): void => {
  storePlicUint32(memory, BigInt(PLIC_SOURCE_UART * 4), 1);
  storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART);
  storePlicUint32(memory, 0x200000n, 0);
  setPlicSourcePending(memory, PLIC_SOURCE_UART, pending);
};

describe('memory', () => {
  it('createMemory packs 8-byte-aligned regions into one SharedArrayBuffer', () => {
    const memory = createTestMemory(64n);
    const ram = memory.regions.get(RAM_REGION_ID);
    const uart = memory.regions.get(UART_REGION_ID);
    const clint = memory.regions.get(CLINT_REGION_ID);
    const plic = memory.regions.get(PLIC_REGION_ID);
    const reservation = memory.regions.get(RESERVATION_REGION_ID);
    const irqLevel = memory.regions.get(IRQ_LEVEL_REGION_ID);
    assert.ok(ram);
    assert.ok(uart);
    assert.ok(clint);
    assert.ok(plic);
    assert.ok(reservation);
    assert.ok(irqLevel);
    assert.equal(ram.hostIndex, 0n);
    assert.equal(ram.hostByteLength, 64n);
    assert.equal(ram.guestByteLength, 64n);
    assert.equal(uart.hostIndex, 64n);
    assert.equal(uart.guestByteLength, 8n);
    assert.ok(uart.hostByteLength > uart.guestByteLength);
    assert.equal(clint.hostIndex % 8n, 0n);
    assert.ok(clint.hostIndex >= uart.hostIndex + uart.hostByteLength);
    assert.equal(plic.hostIndex % 8n, 0n);
    assert.ok(plic.hostIndex >= clint.hostIndex + clint.hostByteLength);
    assert.equal(reservation.hostIndex % 8n, 0n);
    assert.equal(reservation.guestAddress, null);
    assert.ok(reservation.hostIndex >= plic.hostIndex + plic.hostByteLength);
    assert.equal(irqLevel.hostIndex % 8n, 0n);
    assert.equal(irqLevel.guestAddress, null);
    assert.ok(irqLevel.hostIndex >= reservation.hostIndex + reservation.hostByteLength);
    assert.ok(memory.bytes.buffer instanceof SharedArrayBuffer);
    assert.deepEqual(
      memory.regionsByBaseGuestAddress.map(([, id]) => id),
      [RAM_REGION_ID, CLINT_REGION_ID, PLIC_REGION_ID, UART_REGION_ID]
    );
    for (let index = 1; index < memory.regionsByBaseGuestAddress.length; index += 1) {
      const previous = memory.regionsByBaseGuestAddress[index - 1];
      const current = memory.regionsByBaseGuestAddress[index];
      assert.ok(previous);
      assert.ok(current);
      assert.ok(compareUnsignedBytes(previous[0], current[0]) < 0);
    }
  });

  it('createMemory 8-byte-aligns the next region after a short RAM slab', () => {
    // ramSize 1 → next region hostIndex pads from 1 to 8.
    const memory = createTestMemory(1n);
    const ram = memory.regions.get(RAM_REGION_ID);
    const uart = memory.regions.get(UART_REGION_ID);
    const clint = memory.regions.get(CLINT_REGION_ID);
    assert.ok(ram);
    assert.ok(uart);
    assert.ok(clint);
    assert.equal(ram.hostByteLength, 1n);
    assert.equal(uart.hostIndex, 8n);
    assert.equal(clint.hostIndex % 8n, 0n);
    assert.ok(clint.hostIndex > uart.hostIndex);
  });

  it('storeBytes and loadBytes round-trip in RAM', () => {
    const memory = createTestMemory(64n);
    const eight = new Uint8Array([0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]);
    storeBytes({
      memory,
      address: signedNumberToBytes(new Uint8Array(8), 8, 32),
      source: eight,
      byteLength: 8,
    });

    const destination = new Uint8Array(8);
    loadBytes({
      destination,
      memory,
      address: signedNumberToBytes(new Uint8Array(8), 8, 32),
      byteLength: 8,
    });
    assert.deepEqual(destination, eight);
  });

  it('loadBytes zero-extends into the destination high bytes', () => {
    const memory = createTestMemory(64n);
    memory.bytes[4] = 0xab;
    const destination = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    loadBytes({
      destination,
      memory,
      address: signedNumberToBytes(new Uint8Array(8), 4, 32),
      byteLength: 1,
    });
    assert.deepEqual(destination, new Uint8Array([0xab, 0, 0, 0, 0, 0, 0, 0]));
  });

  it('does not wrap addresses above 4GiB into low memory', () => {
    const memory = createTestMemory(64n);
    memory.bytes[16] = 0x42;
    // 2^32 + 16 — must not alias to byte 16.
    const highAddress = new Uint8Array([0x10, 0, 0, 0, 1, 0, 0, 0]);

    const destination = new Uint8Array(8);
    loadBytes({ destination, memory, address: highAddress, byteLength: 1 });
    assert.deepEqual(destination, new Uint8Array(8));

    storeBytes({
      memory,
      address: highAddress,
      source: new Uint8Array([0xff]),
      byteLength: 1,
    });
    assert.equal(memory.bytes[16], 0x42);
  });

  it('maps RAM at a non-zero base without allocating the guest physical-address hole', () => {
    const ramSize = 64n;
    const memory = createMemory(
      machineRegionSpecs({
        ramBaseAddress: HIGH_RAM_BASE,
        ramSize,
        uartBaseAddress: UART_BASE,
        clintBaseAddress: CLINT_BASE,
        plicBaseAddress: PLIC_BASE,
      })
    );

    // Guest physical address 0x8000_0000 + 4 → host index 4
    const ramAddress = new Uint8Array(HIGH_RAM_BASE);
    ramAddress[0] = 4;
    storeBytes({
      memory,
      address: ramAddress,
      source: new Uint8Array([0x5a]),
      byteLength: 1,
    });
    assert.equal(memory.bytes[4], 0x5a);

    // Low guest physical address 4 is unmapped when RAM base is 0x8000_0000
    const low = new Uint8Array(8);
    loadBytes({
      destination: low,
      memory,
      address: signedNumberToBytes(new Uint8Array(8), 4, 32),
      byteLength: 1,
    });
    assert.deepEqual(low, new Uint8Array(8));
  });

  it('rejects a UART window that overlaps RAM', () => {
    assert.throws(
      () =>
        createMemory(
          machineRegionSpecs({
            ramBaseAddress: RAM_BASE,
            ramSize: 0x1000_0000n + 1n,
            uartBaseAddress: UART_BASE,
            clintBaseAddress: CLINT_BASE,
            plicBaseAddress: PLIC_BASE,
          })
        ),
      { message: `${RAM_REGION_ID} window overlaps ${UART_REGION_ID}.` }
    );
  });

  it('allows large RAM when UART sits below a high RAM base', () => {
    const memory = createMemory(
      machineRegionSpecs({
        ramBaseAddress: HIGH_RAM_BASE,
        ramSize: 0x1000_0000n + 1n,
        uartBaseAddress: UART_BASE,
        clintBaseAddress: CLINT_BASE,
        plicBaseAddress: PLIC_BASE,
      })
    );
    assert.ok(memory.bytes.byteLength > Number(0x1000_0000n + 1n));
  });

  it('rejects a CLINT window that overlaps RAM', () => {
    assert.throws(
      () =>
        createMemory(
          machineRegionSpecs({
            ramBaseAddress: CLINT_BASE,
            ramSize: 0xc000n,
            uartBaseAddress: UART_BASE,
            clintBaseAddress: CLINT_BASE,
            plicBaseAddress: PLIC_BASE,
          })
        ),
      { message: `${RAM_REGION_ID} window overlaps ${CLINT_REGION_ID}.` }
    );
  });

  it('rejects a PLIC window that overlaps RAM', () => {
    assert.throws(
      () =>
        createMemory(
          machineRegionSpecs({
            ramBaseAddress: PLIC_BASE,
            ramSize: 0x201008n,
            uartBaseAddress: UART_BASE,
            clintBaseAddress: CLINT_BASE,
            plicBaseAddress: PLIC_BASE,
          })
        ),
      { message: `${RAM_REGION_ID} window overlaps ${PLIC_REGION_ID}.` }
    );
  });

  it('rejects duplicate region ids', () => {
    assert.throws(
      () =>
        createMemory([
          {
            id: 'dup',
            hostByteLength: 8n,
            guestAddress: guest(0n),
            guestByteLength: 8n,
          },
          {
            id: 'dup',
            hostByteLength: 8n,
            guestAddress: guest(8n),
            guestByteLength: 8n,
          },
        ]),
      /Duplicate memory region ID/
    );
  });

  it('rejects a negative hostByteLength', () => {
    assert.throws(
      () =>
        createMemory([
          {
            id: 'bad',
            hostByteLength: -1n,
            guestAddress: guest(0n),
            guestByteLength: 0n,
          },
        ]),
      /hostByteLength must be non-negative/
    );
  });

  it('rejects a negative guestByteLength', () => {
    assert.throws(
      () =>
        createMemory([
          {
            id: 'bad',
            hostByteLength: 8n,
            guestAddress: guest(0n),
            guestByteLength: -1n,
          },
        ]),
      /guestByteLength must be non-negative/
    );
  });

  it('sorts regionsByBaseGuestAddress by guest base (not pack order)', () => {
    const memory = createMemory([
      {
        id: 'high',
        hostByteLength: 8n,
        guestAddress: guest(0x2000n),
        guestByteLength: 8n,
      },
      {
        id: 'low',
        hostByteLength: 8n,
        guestAddress: guest(0x1000n),
        guestByteLength: 8n,
      },
      {
        id: 'hostOnly',
        hostByteLength: 8n,
        guestAddress: null,
        guestByteLength: 0n,
      },
    ]);
    assert.deepEqual(
      memory.regionsByBaseGuestAddress.map(([, id]) => id),
      ['low', 'high']
    );
  });
});

describe('uart queues', () => {
  it('THR store pushes TX; popUartTransmit drains; LSR reflects THRE/TEMT', () => {
    const memory = createTestMemory(64n);

    const lsrEmpty = new Uint8Array(8);
    loadBytes({ destination: lsrEmpty, memory, address: uartAddress(5), byteLength: 1 });
    assert.equal(lsrEmpty[0], LSR_THRE | LSR_TEMT);

    const beforeWake = readUartTxWake(memory);
    assert.equal(beforeWake, 0);
    storeBytes({
      memory,
      address: uartAddress(0),
      source: new Uint8Array([0x41]),
      byteLength: 1,
    });
    assert.equal(readUartTxWake(memory), 1);
    assert.equal(popUartTransmit(memory), 0x41);
    assert.equal(popUartTransmit(memory), null);
    assert.equal(readUartTxWake(memory), 0);

    storeBytes({
      memory,
      address: uartAddress(0),
      source: new Uint8Array([0x42]),
      byteLength: 1,
    });
    assert.equal(readUartTxWake(memory), 1);
    // Push while nonempty keeps level at 1.
    storeBytes({
      memory,
      address: uartAddress(0),
      source: new Uint8Array([0x43]),
      byteLength: 1,
    });
    assert.equal(readUartTxWake(memory), 1);
    const lsrPending = new Uint8Array(8);
    loadBytes({ destination: lsrPending, memory, address: uartAddress(5), byteLength: 1 });
    assert.equal(lsrPending[0]! & LSR_TEMT, 0);
    assert.equal(lsrPending[0]! & LSR_THRE, LSR_THRE);
    assert.equal(popUartTransmit(memory), 0x42);
    assert.equal(popUartTransmit(memory), 0x43);
  });

  it('pushUartReceive then RBR load pops RX and clears DR', () => {
    const memory = createTestMemory(64n);
    assert.equal(pushUartReceive(memory, 0xab), true);

    const lsrReady = new Uint8Array(8);
    loadBytes({ destination: lsrReady, memory, address: uartAddress(5), byteLength: 1 });
    assert.equal(lsrReady[0]! & LSR_DR, LSR_DR);

    const rbr = new Uint8Array(8);
    loadBytes({ destination: rbr, memory, address: uartAddress(0), byteLength: 1 });
    assert.equal(rbr[0], 0xab);

    const lsrAfter = new Uint8Array(8);
    loadBytes({ destination: lsrAfter, memory, address: uartAddress(5), byteLength: 1 });
    assert.equal(lsrAfter[0]! & LSR_DR, 0);

    const emptyRbr = new Uint8Array(8);
    loadBytes({ destination: emptyRbr, memory, address: uartAddress(0), byteLength: 1 });
    assert.equal(emptyRbr[0], 0);
  });

  it('drops RX when the receive queue is full', () => {
    const memory = createTestMemory(64n);
    let filled = 0;
    while (pushUartReceive(memory, filled & 0xff)) {
      filled += 1;
    }
    assert.ok(filled > 0);

    const first = new Uint8Array(8);
    loadBytes({ destination: first, memory, address: uartAddress(0), byteLength: 1 });
    assert.equal(first[0], 0);
  });

  it('drops TX when the transmit queue is full', () => {
    const memory = createTestMemory(64n);
    let filled = 0;
    for (;;) {
      storeBytes({
        memory,
        address: uartAddress(0),
        source: new Uint8Array([filled & 0xff]),
        byteLength: 1,
      });
      const lsr = new Uint8Array(8);
      loadBytes({ destination: lsr, memory, address: uartAddress(5), byteLength: 1 });
      filled += 1;
      if ((lsr[0]! & LSR_THRE) === 0) {
        break;
      }
      assert.ok(filled < 64);
    }

    storeBytes({
      memory,
      address: uartAddress(0),
      source: new Uint8Array([0xff]),
      byteLength: 1,
    });
    assert.equal(popUartTransmit(memory), 0);
    assert.equal(popUartTransmit(memory), 1);
  });

  it('round-trips scratch and ignores LSR writes', () => {
    const memory = createTestMemory(64n);
    storeBytes({
      memory,
      address: uartAddress(7),
      source: new Uint8Array([0x5a]),
      byteLength: 1,
    });
    const scratch = new Uint8Array(8);
    loadBytes({ destination: scratch, memory, address: uartAddress(7), byteLength: 1 });
    assert.equal(scratch[0], 0x5a);

    storeBytes({
      memory,
      address: uartAddress(5),
      source: new Uint8Array([0xff]),
      byteLength: 1,
    });
    const lsr = new Uint8Array(8);
    loadBytes({ destination: lsr, memory, address: uartAddress(5), byteLength: 1 });
    assert.equal(lsr[0], LSR_THRE | LSR_TEMT);
  });

  it('IER/IIR drive PLIC source 10 for RX and THRE (sticky clears on IIR read)', () => {
    const memory = createTestMemory(64n);
    const IER_ERBFI = 0x01;
    const IER_ETBEI = 0x02;
    const IIR_NO_INTERRUPT = 0x01;
    const IIR_THRE = 0x02;
    const IIR_RDA = 0x04;

    storePlicUint32(memory, BigInt(PLIC_SOURCE_UART * 4), 1);
    storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART);
    storePlicUint32(memory, 0x200000n, 0);

    const iir = new Uint8Array(8);
    loadBytes({ destination: iir, memory, address: uartAddress(2), byteLength: 1 });
    assert.equal(iir[0], IIR_NO_INTERRUPT);
    assert.equal(isPlicMachineExternalPending(memory), false);

    // ETBEI + THRE (TX has room) → sticky THRE IRQ and MEIP.
    storeBytes({
      memory,
      address: uartAddress(1),
      source: new Uint8Array([IER_ETBEI]),
      byteLength: 1,
    });
    assert.equal(isPlicMachineExternalPending(memory), true);
    loadBytes({ destination: iir, memory, address: uartAddress(2), byteLength: 1 });
    assert.equal(iir[0], IIR_THRE);
    // Reading IIR clears the sticky THRE interrupt.
    assert.equal(isPlicMachineExternalPending(memory), false);
    loadBytes({ destination: iir, memory, address: uartAddress(2), byteLength: 1 });
    assert.equal(iir[0], IIR_NO_INTERRUPT);

    // THR write clears sticky; THRE stays set but does not re-fire until it falls then rises.
    storeBytes({
      memory,
      address: uartAddress(1),
      source: new Uint8Array([IER_ETBEI]),
      byteLength: 1,
    });
    assert.equal(isPlicMachineExternalPending(memory), true);
    storeBytes({
      memory,
      address: uartAddress(0),
      source: new Uint8Array([0x41]),
      byteLength: 1,
    });
    assert.equal(isPlicMachineExternalPending(memory), false);
    loadBytes({ destination: iir, memory, address: uartAddress(2), byteLength: 1 });
    assert.equal(iir[0], IIR_NO_INTERRUPT);

    // ERBFI + RX byte → RDA outranks; RBR clears RX pending (TX still holds 0x41).
    storeBytes({
      memory,
      address: uartAddress(1),
      source: new Uint8Array([IER_ERBFI | IER_ETBEI]),
      byteLength: 1,
    });
    assert.equal(pushUartReceive(memory, 0xab), true);
    assert.equal(isPlicMachineExternalPending(memory), true);
    loadBytes({ destination: iir, memory, address: uartAddress(2), byteLength: 1 });
    assert.equal(iir[0], IIR_RDA);

    const rbr = new Uint8Array(8);
    loadBytes({ destination: rbr, memory, address: uartAddress(0), byteLength: 1 });
    assert.equal(rbr[0], 0xab);
    // IER write armed sticky THRE while TX still had room; after RDA clears, THRE is next.
    assert.equal(isPlicMachineExternalPending(memory), true);
    loadBytes({ destination: iir, memory, address: uartAddress(2), byteLength: 1 });
    assert.equal(iir[0], IIR_THRE);
    assert.equal(isPlicMachineExternalPending(memory), false);

    // Pop while THRE already set does not re-arm (needs a rising edge).
    assert.equal(popUartTransmit(memory), 0x41);
    loadBytes({ destination: iir, memory, address: uartAddress(2), byteLength: 1 });
    assert.equal(iir[0], IIR_NO_INTERRUPT);
    assert.equal(isPlicMachineExternalPending(memory), false);
  });

  it('ETBEI fires on THRE (queue not full), not only TEMT', () => {
    const memory = createTestMemory(64n);
    const IER_ETBEI = 0x02;
    const IIR_THRE = 0x02;

    storePlicUint32(memory, BigInt(PLIC_SOURCE_UART * 4), 1);
    storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART);
    storePlicUint32(memory, 0x200000n, 0);

    // Fill TX until not empty but still has room (THRE set, TEMT clear).
    storeBytes({
      memory,
      address: uartAddress(0),
      source: new Uint8Array([0x11]),
      byteLength: 1,
    });
    const lsr = new Uint8Array(8);
    loadBytes({ destination: lsr, memory, address: uartAddress(5), byteLength: 1 });
    assert.equal(lsr[0]! & LSR_TEMT, 0);
    assert.equal(lsr[0]! & LSR_THRE, LSR_THRE);

    storeBytes({
      memory,
      address: uartAddress(1),
      source: new Uint8Array([IER_ETBEI]),
      byteLength: 1,
    });
    assert.equal(isPlicMachineExternalPending(memory), true);
    const iir = new Uint8Array(8);
    loadBytes({ destination: iir, memory, address: uartAddress(2), byteLength: 1 });
    assert.equal(iir[0], IIR_THRE);
  });
});

describe('clint', () => {
  const clintAddress = (offset: bigint): ReadonlyUint8Array =>
    unsignedBigIntToBytes(new Uint8Array(8), 0x0200_0000n + offset);

  it('resets with mtimecmp all-ones so the timer is not pending', () => {
    const memory = createTestMemory(64n);
    assert.equal(isClintMachineTimerPending(memory), false);
  });

  it('msip bit 0 drives the software IRQ wire', () => {
    const memory = createTestMemory(64n);
    assert.equal(isClintMachineSoftwarePending(memory), false);

    storeBytes({
      memory,
      address: clintAddress(0n),
      source: new Uint8Array([1, 0, 0, 0]),
      byteLength: 4,
    });
    assert.equal(isClintMachineSoftwarePending(memory), true);

    const msip = new Uint8Array(8);
    loadBytes({ destination: msip, memory, address: clintAddress(0n), byteLength: 4 });
    assert.deepEqual(msip.subarray(0, 4), new Uint8Array([1, 0, 0, 0]));

    storeBytes({
      memory,
      address: clintAddress(0n),
      source: new Uint8Array([0, 0, 0, 0]),
      byteLength: 4,
    });
    assert.equal(isClintMachineSoftwarePending(memory), false);
  });

  it('msip 0→1 publishes MSIP into the irq-level word for wfi', () => {
    const memory = createTestMemory(64n);
    assert.equal(readIrqLevel(memory) & IRQ_LEVEL_MSIP, 0);
    storeBytes({
      memory,
      address: clintAddress(0n),
      source: new Uint8Array([1, 0, 0, 0]),
      byteLength: 4,
    });
    assert.equal(readIrqLevel(memory) & IRQ_LEVEL_MSIP, IRQ_LEVEL_MSIP);
    // Level stays asserted: word unchanged.
    storeBytes({
      memory,
      address: clintAddress(0n),
      source: new Uint8Array([1, 0, 0, 0]),
      byteLength: 4,
    });
    assert.equal(readIrqLevel(memory) & IRQ_LEVEL_MSIP, IRQ_LEVEL_MSIP);
  });

  it('asserts pending when mtime is written at or above mtimecmp', () => {
    const memory = createTestMemory(64n);
    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      source: unsignedBigIntToBytes(new Uint8Array(8), 100n),
      byteLength: 8,
    });
    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIME_OFFSET),
      source: unsignedBigIntToBytes(new Uint8Array(8), 100n),
      byteLength: 8,
    });
    assert.equal(isClintMachineTimerPending(memory), true);

    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      source: unsignedBigIntToBytes(new Uint8Array(8), 10_000n),
      byteLength: 8,
    });
    assert.equal(isClintMachineTimerPending(memory), false);
  });

  it('round-trips mtimecmp through loadBytes/storeBytes', () => {
    const memory = createTestMemory(64n);
    const value = unsignedBigIntToBytes(new Uint8Array(8), 0x0123_4567_89ab_cdefn);
    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      source: value,
      byteLength: 8,
    });
    const destination = new Uint8Array(8);
    loadBytes({
      destination,
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      byteLength: 8,
    });
    assert.deepEqual(destination, value);
  });

  it('aligned mtime/mtimecmp ld/sd use a single atomic u64', () => {
    const memory = createTestMemory(64n);
    const value = unsignedBigIntToBytes(new Uint8Array(8), 0x1111_2222_3333_4444n);
    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      source: value,
      byteLength: 8,
    });
    const destination = new Uint8Array(8);
    loadBytes({
      destination,
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      byteLength: 8,
    });
    assert.deepEqual(destination, value);

    // Partial multi-byte store merges via one atomic u64 write (no mid-store tear).
    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      source: new Uint8Array([0xaa, 0xbb]),
      byteLength: 2,
    });
    const afterPartial = new Uint8Array(8);
    loadBytes({
      destination: afterPartial,
      memory,
      address: clintAddress(CLINT_MTIMECMP_OFFSET),
      byteLength: 8,
    });
    assert.equal(afterPartial[0], 0xaa);
    assert.equal(afterPartial[1], 0xbb);
    assert.equal(afterPartial[2], value[2]);
    assert.equal(afterPartial[7], value[7]);

    // mtime store reseats epoch once; a subsequent load syncs from the host clock.
    storeBytes({
      memory,
      address: clintAddress(CLINT_MTIME_OFFSET),
      source: unsignedBigIntToBytes(new Uint8Array(8), 0n),
      byteLength: 8,
    });
    const mtime = new Uint8Array(8);
    loadBytes({
      destination: mtime,
      memory,
      address: clintAddress(CLINT_MTIME_OFFSET),
      byteLength: 8,
    });
    const loaded =
      BigInt(mtime[0]!) |
      (BigInt(mtime[1]!) << 8n) |
      (BigInt(mtime[2]!) << 16n) |
      (BigInt(mtime[3]!) << 24n) |
      (BigInt(mtime[4]!) << 32n) |
      (BigInt(mtime[5]!) << 40n) |
      (BigInt(mtime[6]!) << 48n) |
      (BigInt(mtime[7]!) << 56n);
    assert.ok(loaded >= 0n);
  });
});

describe('plic', () => {
  it('UART source + M enable/priority above threshold asserts MEIP wire', () => {
    const memory = createTestMemory(64n);
    assert.equal(isPlicMachineExternalPending(memory), false);

    storePlicUint32(memory, BigInt(PLIC_SOURCE_UART * 4), 7); // priority
    storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART); // enable M
    storePlicUint32(memory, 0x200000n, 0); // threshold
    setPlicSourcePending(memory, PLIC_SOURCE_UART, true);

    assert.equal(isPlicMachineExternalPending(memory), true);
    assert.equal(loadPlicUint32(memory, 0x1000n) & (1 << PLIC_SOURCE_UART), 1 << PLIC_SOURCE_UART);
  });

  it('claim returns the UART id, clears pending, and complete re-arms from level', () => {
    const memory = createTestMemory(64n);
    setUartPlicPending(memory, true);
    assert.equal(isPlicMachineExternalPending(memory), true);
    assert.equal(loadPlicUint32(memory, 0x1000n) & (1 << PLIC_SOURCE_UART), 1 << PLIC_SOURCE_UART);

    assert.equal(loadPlicUint32(memory, 0x200004n), PLIC_SOURCE_UART);
    assert.equal(isPlicMachineExternalPending(memory), false);
    // Claim clears the global pending bit (SiFive/QEMU).
    assert.equal(loadPlicUint32(memory, 0x1000n) & (1 << PLIC_SOURCE_UART), 0);

    // Complete clears the gateway; input level still high → pending and MEIP return.
    storePlicUint32(memory, 0x200004n, PLIC_SOURCE_UART);
    assert.equal(loadPlicUint32(memory, 0x1000n) & (1 << PLIC_SOURCE_UART), 1 << PLIC_SOURCE_UART);
    assert.equal(isPlicMachineExternalPending(memory), true);
  });

  it('only one context successfully claims a pending source', () => {
    const memory = createTestMemory(64n);
    storePlicUint32(memory, BigInt(PLIC_SOURCE_UART * 4), 1);
    storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART); // enable M
    storePlicUint32(memory, 0x2080n, 1 << PLIC_SOURCE_UART); // enable S
    storePlicUint32(memory, 0x200000n, 0);
    storePlicUint32(memory, 0x201000n, 0);
    setPlicSourcePending(memory, PLIC_SOURCE_UART, true);

    assert.equal(loadPlicUint32(memory, 0x200004n), PLIC_SOURCE_UART);
    assert.equal(loadPlicUint32(memory, 0x201004n), 0);
    assert.equal(loadPlicUint32(memory, 0x1000n) & (1 << PLIC_SOURCE_UART), 0);
  });

  it('source pending publishes MEIP into the irq-level word', () => {
    const memory = createTestMemory(64n);
    storePlicUint32(memory, BigInt(PLIC_SOURCE_UART * 4), 1);
    storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART);
    assert.equal(readIrqLevel(memory) & IRQ_LEVEL_MEIP, 0);
    setPlicSourcePending(memory, PLIC_SOURCE_UART, true);
    assert.equal(readIrqLevel(memory) & IRQ_LEVEL_MEIP, IRQ_LEVEL_MEIP);
    setPlicSourcePending(memory, PLIC_SOURCE_UART, true);
    assert.equal(readIrqLevel(memory) & IRQ_LEVEL_MEIP, IRQ_LEVEL_MEIP);
  });

  it('pending is not CSR/MMIO-writable', () => {
    const memory = createTestMemory(64n);
    storePlicUint32(memory, 0x1000n, 0xffff_ffff);
    assert.equal(loadPlicUint32(memory, 0x1000n), 0);
  });

  it('threshold gates claimable sources and wire level', () => {
    const memory = createTestMemory(64n);
    storePlicUint32(memory, BigInt(PLIC_SOURCE_UART * 4), 3); // priority 3
    storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART);
    storePlicUint32(memory, 0x200000n, 3); // threshold == priority → not claimable
    setPlicSourcePending(memory, PLIC_SOURCE_UART, true);
    assert.equal(isPlicMachineExternalPending(memory), false);
    assert.equal(loadPlicUint32(memory, 0x200004n), 0);

    storePlicUint32(memory, 0x200000n, 2); // threshold below priority
    assert.equal(isPlicMachineExternalPending(memory), true);
    assert.equal(loadPlicUint32(memory, 0x200004n), PLIC_SOURCE_UART);
  });

  it('equal-priority claim tie-breaks to the lowest source id', () => {
    const memory = createTestMemory(64n);
    const sourceLow = 3;
    const sourceHigh = 12;
    storePlicUint32(memory, BigInt(sourceLow * 4), 5);
    storePlicUint32(memory, BigInt(sourceHigh * 4), 5);
    storePlicUint32(memory, 0x2000n, (1 << sourceLow) | (1 << sourceHigh));
    storePlicUint32(memory, 0x200000n, 0);
    setPlicSourcePending(memory, sourceLow, true);
    setPlicSourcePending(memory, sourceHigh, true);
    assert.equal(loadPlicUint32(memory, 0x200004n), sourceLow);
    assert.equal(loadPlicUint32(memory, 0x200004n), sourceHigh);
  });

  it('complete of an id not claimed by that context is ignored', () => {
    const memory = createTestMemory(64n);
    storePlicUint32(memory, BigInt(PLIC_SOURCE_UART * 4), 1);
    storePlicUint32(memory, 0x2000n, 1 << PLIC_SOURCE_UART); // enable M
    storePlicUint32(memory, 0x2080n, 1 << PLIC_SOURCE_UART); // enable S
    storePlicUint32(memory, 0x200000n, 0);
    storePlicUint32(memory, 0x201000n, 0);
    setPlicSourcePending(memory, PLIC_SOURCE_UART, true);

    assert.equal(loadPlicUint32(memory, 0x200004n), PLIC_SOURCE_UART); // M claims
    assert.equal(isPlicMachineExternalPending(memory), false);
    // S-context complete must not release M's claim (SiFive).
    storePlicUint32(memory, 0x201004n, PLIC_SOURCE_UART);
    assert.equal(loadPlicUint32(memory, 0x1000n) & (1 << PLIC_SOURCE_UART), 0);
    assert.equal(isPlicMachineExternalPending(memory), false);
    // M-context complete re-arms from the still-high input level.
    storePlicUint32(memory, 0x200004n, PLIC_SOURCE_UART);
    assert.equal(loadPlicUint32(memory, 0x1000n) & (1 << PLIC_SOURCE_UART), 1 << PLIC_SOURCE_UART);
    assert.equal(isPlicMachineExternalPending(memory), true);
  });

  it('claim then device re-assert while claimed does not set pending until complete', () => {
    const memory = createTestMemory(64n);
    setUartPlicPending(memory, true);
    assert.equal(loadPlicUint32(memory, 0x200004n), PLIC_SOURCE_UART);
    assert.equal(loadPlicUint32(memory, 0x1000n) & (1 << PLIC_SOURCE_UART), 0);
    // UART refreshes level high again while gateway is claimed — pending stays clear.
    setPlicSourcePending(memory, PLIC_SOURCE_UART, true);
    assert.equal(loadPlicUint32(memory, 0x1000n) & (1 << PLIC_SOURCE_UART), 0);
    storePlicUint32(memory, 0x200004n, PLIC_SOURCE_UART);
    assert.equal(loadPlicUint32(memory, 0x1000n) & (1 << PLIC_SOURCE_UART), 1 << PLIC_SOURCE_UART);
  });
});

describe('atomic load/store/cas', () => {
  it('succeeds on aligned RAM', () => {
    const memory = createTestMemory(64n);
    const address = signedNumberToBytes(new Uint8Array(8), 8, 32) as ReadonlyUint8Array;
    const source = signedNumberToBytes(new Uint8Array(8), 0x11223344, 32);
    assert.equal(atomicStoreBytes({ memory, address, source, byteLength: 4 }), true);
    const destination = new Uint8Array(8);
    assert.equal(atomicLoadBytes({ destination, memory, address, byteLength: 4 }), true);
    assert.deepEqual(destination.subarray(0, 4), source.subarray(0, 4));

    const expected = source;
    const desired = signedNumberToBytes(new Uint8Array(8), 0x55667788, 32);
    assert.equal(
      atomicCompareExchangeBytes({
        destination,
        memory,
        address,
        byteLength: 4,
        expected,
        desired,
      }),
      true
    );
  });

  it('fails on unmapped addresses and on MMIO regions', () => {
    const memory = createTestMemory(64n);
    const destination = new Uint8Array(8);
    const source = new Uint8Array(8);
    const unmappedHigh = unsignedBigIntToBytes(
      new Uint8Array(8),
      0x1_0000_0010n
    ) as ReadonlyUint8Array;
    assert.equal(
      atomicLoadBytes({ destination, memory, address: unmappedHigh, byteLength: 4 }),
      false
    );
    assert.equal(atomicStoreBytes({ memory, address: unmappedHigh, source, byteLength: 4 }), false);
    assert.equal(
      atomicCompareExchangeBytes({
        destination,
        memory,
        address: unmappedHigh,
        byteLength: 4,
        expected: source,
        desired: source,
      }),
      false
    );
    assert.equal(
      atomicLoadBytes({ destination, memory, address: UART_BASE, byteLength: 4 }),
      false
    );
    assert.equal(atomicStoreBytes({ memory, address: UART_BASE, source, byteLength: 4 }), false);
  });

  it('dispatches MMIO stores to the UART region (scratch)', () => {
    const memory = createTestMemory(64n);
    const scratch = unsignedBigIntToBytes(new Uint8Array(8), 0x1000_0007n) as ReadonlyUint8Array;
    storeBytes({
      memory,
      address: scratch,
      source: new Uint8Array([0x5a]),
      byteLength: 1,
    });
    const destination = new Uint8Array(8);
    loadBytes({ destination, memory, address: scratch, byteLength: 1 });
    assert.equal(destination[0], 0x5a);
  });
});
