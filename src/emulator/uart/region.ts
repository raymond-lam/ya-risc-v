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
 * UART region layout — guest 16550 window + host-only queues/wake indexing.
 *
 * Guest (dense prefix of the host slab):
 *   guestAddress + 0..7  →  hostIndex + 0..7   (RBR/THR … SCR)
 *
 * Host-only tail (not reachable via loadBytes/storeBytes):
 *   +8   queue meta (rx/tx head/tail)
 *   +12  RX ring
 *   +28  TX ring
 *   +44  TX nonempty wake Int32
 */

import { bigIntAsNumber } from '#utils/int';
import { WAKE_HOST_SIZE } from '#emulator/wake';
import type { Memory } from '#emulator/memory';

/** Packed-region id for the UART (`createMemory` / `regions.get`). */
const UART_REGION_ID = 'uart';

/** Guest-visible 16550 register window (dense prefix of this region). */
const UART_GUEST_BYTE_LENGTH = 8n;

/** Bytes of ring storage per direction (one slot reserved: head===tail ⇒ empty). */
const UART_QUEUE_CAPACITY = 16;

/** Relative host offsets inside the UART region (from that region's hostIndex). */
const UART_HOST_OFFSET = {
  /** Guest-addressable 16550 registers (8 bytes). */
  registers: 0,
  /** Queue meta: rxHead, rxTail, txHead, txTail. */
  meta: 8,
  rxData: 12,
  txData: 28,
  /** Int32 TX nonempty level (`0`/`1`) for the terminal pump. */
  txWake: 44,
} as const;

/** Contiguous host slab size (registers + meta + rings + wake). */
const UART_HOST_BYTE_LENGTH = BigInt(UART_HOST_OFFSET.txWake + WAKE_HOST_SIZE);

/** Byte offsets into queue meta: rxHead, rxTail, txHead, txTail. */
const META_RX_HEAD = 0;
const META_RX_TAIL = 1;
const META_TX_HEAD = 2;
const META_TX_TAIL = 3;

/**
 * Host slot for the sticky THRE IRQ bit (IIR is derived; this byte is not guest
 * IIR storage). 1 = THRE interrupt pending until IIR read or THR write.
 */
const THRE_IRQ_STICKY_REGISTER = 2;

const uartRegion = (memory: Memory) => {
  const region = memory.regions.get(UART_REGION_ID);
  if (region === undefined) {
    throw new Error(`Memory region '${UART_REGION_ID}' is not packed.`);
  }
  if (region.guestAddress === null) {
    throw new Error(`Memory region '${UART_REGION_ID}' is host-only; expected a guest window.`);
  }
  return region;
};

/** TypedArray index of byte `offset` within the UART host slab. */
const uartByteIndex = (memory: Memory, offset: number): number =>
  bigIntAsNumber(uartRegion(memory).hostIndex + BigInt(offset));

const metaIndex = (memory: Memory, offset: number): number =>
  uartByteIndex(memory, UART_HOST_OFFSET.meta + offset);

const registerHostIndex = (memory: Memory, registerIndex: number): number =>
  uartByteIndex(memory, UART_HOST_OFFSET.registers + registerIndex);

const rxDataIndex = (memory: Memory, slot: number): number =>
  uartByteIndex(memory, UART_HOST_OFFSET.rxData + slot);

const txDataIndex = (memory: Memory, slot: number): number =>
  uartByteIndex(memory, UART_HOST_OFFSET.txData + slot);

const uartRegisterByte = (memory: Memory, registerIndex: number): number =>
  Atomics.load(memory.bytes, registerHostIndex(memory, registerIndex));

const storeUartRegisterByte = (memory: Memory, registerIndex: number, value: number): void => {
  Atomics.store(memory.bytes, registerHostIndex(memory, registerIndex), value & 0xff);
};

export {
  META_RX_HEAD,
  META_RX_TAIL,
  META_TX_HEAD,
  META_TX_TAIL,
  THRE_IRQ_STICKY_REGISTER,
  UART_GUEST_BYTE_LENGTH,
  UART_HOST_BYTE_LENGTH,
  UART_HOST_OFFSET,
  UART_QUEUE_CAPACITY,
  UART_REGION_ID,
  metaIndex,
  registerHostIndex,
  rxDataIndex,
  storeUartRegisterByte,
  txDataIndex,
  uartByteIndex,
  uartRegisterByte,
};
