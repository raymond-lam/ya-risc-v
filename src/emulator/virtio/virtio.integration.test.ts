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
 * VirtIO-MMIO v2 block device integration test for issue #62.
 *
 * Boots the real `Emulator` (CPU + timer + terminal + virtio device workers over one
 * `SharedArrayBuffer`) with a real disk image and real guest program. The guest
 * negotiates modern VirtIO-MMIO v2 (probe ids/features/status), sets up one split
 * queue with a 3-descriptor read of sector 0, notifies the device exactly once, then
 * proves non-blocking progress with a masked-interrupt deterministic count: it runs
 * exactly N pure-register increments after QueueNotify (interrupts masked), stores the
 * exact counter, unmasks, and waits for the device interrupt. The interrupt handler
 * claims PLIC source 1, acknowledges InterruptStatus bit 0, and reads the used ring.
 * The guest verifies the read bytes, used-ring id/len/index, PLIC source, and emits
 * PASS vs FAIL via UART. Termination uses TEMT-gated syscon poweroff.
 *
 * The guest image is an inline `Uint8Array` literal: one 4-byte instruction per line
 * with a `// mnemonic operands — intent` comment, no 64-bit padding. Every word is
 * verified through `decode` against `createTestMemory` before the integration run
 * (the integration run is the arbiter, per AGENTS.md).
 *
 * Guest RAM layout (data base 0x8000_8000, set by the program):
 *   +0x000  descriptor table  (8 × 16 = 128 bytes)
 *   +0x100  avail ring        (flags u16, idx u16, ring[8] u16)
 *   +0x200  used ring         (flags u16, idx u16, used[8] {id u32, len u32})
 *   +0x300  data buffer       (512 bytes — sector 0 read destination)
 *   +0x500  status byte       (1 byte — device completion status)
 *   +0x600  request header    (16 bytes — type=0/sector=0)
 *   +0x700  counter word      (8 bytes — deterministic progress counter)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import { create, type EmulatorHandle } from '#emulator';
import decode from '#emulator/cpu/decode';
import { FOUR_BYTES } from '#emulator/cpu/registers';
import { CLINT_GUEST_BYTE_LENGTH, CLINT_REGION_ID } from '#emulator/clint';
import { PLIC_GUEST_BYTE_LENGTH, PLIC_REGION_ID } from '#emulator/plic';
import { RAM_REGION_ID } from '#emulator/ram';
import { SYSCON_GUEST_BYTE_LENGTH, SYSCON_REGION_ID } from '#emulator/syscon';
import { UART_GUEST_BYTE_LENGTH, UART_REGION_ID } from '#emulator/uart';
import { VIRTIO_GUEST_BYTE_LENGTH, VIRTIO_REGION_ID } from '#emulator/virtio';
import createTestMemory from '#test/guest-memory';
import {
  collectOutput,
  guestAddress,
  RAM_BASE,
  settleEmulator,
  TIMEBASE_HZ,
  type GuestOutput,
} from '#test/integration-harness';
import type { ReadonlyUint8Array } from '#types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Counter the guest increments before unmasking interrupts; printed as '*' (42). */
const N = 42;
/** RAM window the guest image and its data live in. */
const RAM_BYTE_LENGTH = 0x100_000n;
/** The guest prints the counter byte first, then 'PASS'. */
const EXPECTED_OUTPUT = `${String.fromCharCode(N)}PASS`;

// ─── Guest image ──────────────────────────────────────────────────────────────

// prettier-ignore
const guestImage = new Uint8Array([
  0x37, 0x05, 0x00, 0x10, // lui  x10, 0x10000 — UART base 0x1000_0000
  0xb7, 0x15, 0x00, 0x10, // lui  x11, 0x10001 — VirtIO base 0x1000_1000
  0x37, 0x06, 0x00, 0x0c, // lui  x12, 0xc000 — PLIC base 0x0c00_0000
  0xb7, 0x06, 0x10, 0x00, // lui  x13, 0x100 — SYSCON base 0x0010_0000
  0x37, 0x07, 0x00, 0x80, // lui  x14, 0x80000 — 0xFFFFFFFF80000000
  0x13, 0x17, 0x07, 0x02, // slli x14, x14, 32 — drop the lui sign extension
  0x13, 0x57, 0x07, 0x02, // srli x14, x14, 32 — 0x0000_0000_8000_0000
  0x37, 0x83, 0x00, 0x00, // lui  x6, 0x8 — 0x8000
  0x33, 0x07, 0x67, 0x00, // add  x14, x14, x6 — x14 = 0x8000_8000 (data base)
  0x83, 0xa7, 0x05, 0x00, // lw   x15, 0(x11) — MagicValue
  0x37, 0x78, 0x72, 0x74, // lui  x16, 0x74727 — magic 0x74726976
  0x13, 0x08, 0x68, 0x97, // addi x16, x16, -1674 — magic 0x74726976
  0x63, 0x92, 0x07, 0x27, // bne  x15, x16, fail — magic mismatch
  0x83, 0xa7, 0x45, 0x00, // lw   x15, 4(x11) — Version
  0x13, 0x08, 0x20, 0x00, // addi x16, x0, 2 — expected v2
  0x63, 0x9c, 0x07, 0x25, // bne  x15, x16, fail — version mismatch
  0x83, 0xa7, 0x85, 0x00, // lw   x15, 8(x11) — DeviceID
  0x13, 0x08, 0x20, 0x00, // addi x16, x0, 2 — block device
  0x63, 0x96, 0x07, 0x25, // bne  x15, x16, fail — device ID mismatch
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — DeviceFeaturesSel = 1
  0x23, 0xaa, 0xf5, 0x00, // sw   x15, 0x14(x11) — DeviceFeaturesSel = 1
  0x83, 0xa7, 0x05, 0x01, // lw   x15, 0x10(x11) — DeviceFeatures
  0x13, 0x08, 0x10, 0x00, // addi x16, x0, 1 — VERSION_1
  0x63, 0x9c, 0x07, 0x23, // bne  x15, x16, fail — VERSION_1 not advertised
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — ACKNOWLEDGE
  0x23, 0xa8, 0xf5, 0x06, // sw   x15, 0x70(x11) — Status
  0x93, 0x07, 0x30, 0x00, // addi x15, x0, 3 — ACK|DRIVER
  0x23, 0xa8, 0xf5, 0x06, // sw   x15, 0x70(x11) — Status
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — DriverFeaturesSel = 1
  0x23, 0xa2, 0xf5, 0x02, // sw   x15, 0x24(x11) — DriverFeaturesSel = 1
  0x23, 0xa0, 0xf5, 0x02, // sw   x15, 0x20(x11) — DriverFeatures = 1 (VERSION_1)
  0x23, 0xa2, 0x05, 0x02, // sw   x0, 0x24(x11) — DriverFeaturesSel = 0
  0x23, 0xa0, 0x05, 0x02, // sw   x0, 0x20(x11) — DriverFeatures = 0
  0x93, 0x07, 0xb0, 0x00, // addi x15, x0, 11 — ACK|DRIVER|FEATURES_OK
  0x23, 0xa8, 0xf5, 0x06, // sw   x15, 0x70(x11) — Status
  0x83, 0xa7, 0x05, 0x07, // lw   x15, 0x70(x11) — read Status
  0x13, 0xf8, 0x87, 0x00, // andi x16, x15, 8 — FEATURES_OK bit
  0x63, 0x00, 0x08, 0x20, // beq  x16, x0, fail — FEATURES_OK cleared
  0x93, 0x07, 0xf0, 0x00, // addi x15, x0, 15 — ACK|DRIVER|FOK|DRIVER_OK
  0x23, 0xa8, 0xf5, 0x06, // sw   x15, 0x70(x11) — Status = DRIVER_OK
  0x23, 0xa8, 0x05, 0x02, // sw   x0, 0x30(x11) — QueueSel = 0
  0x83, 0xa7, 0x45, 0x03, // lw   x15, 0x34(x11) — QueueNumMax
  0x13, 0x08, 0x80, 0x00, // addi x16, x0, 8 — expected QueueNumMax
  0x63, 0x94, 0x07, 0x1f, // bne  x15, x16, fail — QueueNumMax != 8
  0x93, 0x07, 0x80, 0x00, // addi x15, x0, 8 — QueueNum = 8
  0x23, 0xac, 0xf5, 0x02, // sw   x15, 0x38(x11) — QueueNum
  0x23, 0xa0, 0xe5, 0x08, // sw   x14, 0x80(x11) — QueueDescLow
  0x93, 0x57, 0x07, 0x02, // srli x15, x14, 32 — descriptor table high word
  0x23, 0xa2, 0xf5, 0x08, // sw   x15, 0x84(x11) — QueueDescHigh
  0x93, 0x07, 0x07, 0x10, // addi x15, x14, 0x100 — avail ring
  0x23, 0xa8, 0xf5, 0x08, // sw   x15, 0x90(x11) — QueueDriverLow
  0x13, 0xd8, 0x07, 0x02, // srli x16, x15, 32 — avail ring high word
  0x23, 0xaa, 0x05, 0x09, // sw   x16, 0x94(x11) — QueueDriverHigh
  0x93, 0x07, 0x07, 0x20, // addi x15, x14, 0x200 — used ring
  0x23, 0xa0, 0xf5, 0x0a, // sw   x15, 0xa0(x11) — QueueDeviceLow
  0x13, 0xd8, 0x07, 0x02, // srli x16, x15, 32 — used ring high word
  0x23, 0xa2, 0x05, 0x0b, // sw   x16, 0xa4(x11) — QueueDeviceHigh
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — QueueReady = 1
  0x23, 0xa2, 0xf5, 0x04, // sw   x15, 0x44(x11) — QueueReady = 1
  0x93, 0x07, 0x07, 0x60, // addi x15, x14, 0x600 — header buf
  0x23, 0x30, 0xf7, 0x00, // sd   x15, 0(x14) — desc[0].addr
  0x93, 0x07, 0x00, 0x01, // addi x15, x0, 16 — desc[0].len
  0x23, 0x24, 0xf7, 0x00, // sw   x15, 8(x14) — desc[0].len
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — NEXT
  0x23, 0x16, 0xf7, 0x00, // sh   x15, 12(x14) — desc[0].flags
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — desc[0].next
  0x23, 0x17, 0xf7, 0x00, // sh   x15, 14(x14) — desc[0].next
  0x93, 0x07, 0x07, 0x30, // addi x15, x14, 0x300 — data buf
  0x23, 0x38, 0xf7, 0x00, // sd   x15, 16(x14) — desc[1].addr
  0x93, 0x07, 0x00, 0x20, // addi x15, x0, 512 — desc[1].len
  0x23, 0x2c, 0xf7, 0x00, // sw   x15, 24(x14) — desc[1].len
  0x93, 0x07, 0x30, 0x00, // addi x15, x0, 3 — NEXT|WRITE
  0x23, 0x1e, 0xf7, 0x00, // sh   x15, 28(x14) — desc[1].flags
  0x93, 0x07, 0x20, 0x00, // addi x15, x0, 2 — desc[1].next
  0x23, 0x1f, 0xf7, 0x00, // sh   x15, 30(x14) — desc[1].next
  0x93, 0x07, 0x07, 0x50, // addi x15, x14, 0x500 — status buf
  0x23, 0x30, 0xf7, 0x02, // sd   x15, 32(x14) — desc[2].addr
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — desc[2].len
  0x23, 0x24, 0xf7, 0x02, // sw   x15, 40(x14) — desc[2].len
  0x93, 0x07, 0x20, 0x00, // addi x15, x0, 2 — WRITE
  0x23, 0x16, 0xf7, 0x02, // sh   x15, 44(x14) — desc[2].flags
  0x23, 0x17, 0x07, 0x02, // sh   x0, 46(x14) — desc[2].next = 0
  0x23, 0x30, 0x07, 0x60, // sd   x0, 0x600(x14) — header[0:8] = 0 (type IN)
  0x23, 0x34, 0x07, 0x60, // sd   x0, 0x608(x14) — header[8:16] = 0 (sector 0)
  0x23, 0x10, 0x07, 0x10, // sh   x0, 0x100(x14) — avail.flags = 0
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — avail.idx = 1
  0x23, 0x11, 0xf7, 0x10, // sh   x15, 0x102(x14) — avail.idx = 1
  0x23, 0x12, 0x07, 0x10, // sh   x0, 0x104(x14) — avail.ring[0] = 0
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — PLIC priority[1] = 1
  0x23, 0x22, 0xf6, 0x00, // sw   x15, 4(x12) — priority[1] = 1
  0x37, 0x28, 0x00, 0x00, // lui  x16, 2 — 0x2000
  0x33, 0x03, 0x06, 0x01, // add  x6, x12, x16 — enable M addr
  0x93, 0x07, 0x20, 0x00, // addi x15, x0, 2 — bit 1
  0x23, 0x20, 0xf3, 0x00, // sw   x15, 0(x6) — enable M source 1
  0x37, 0x08, 0x20, 0x00, // lui  x16, 0x200 — 0x200000
  0x33, 0x03, 0x06, 0x01, // add  x6, x12, x16 — threshold/claim addr
  0x23, 0x20, 0x03, 0x00, // sw   x0, 0(x6) — threshold M = 0
  0x97, 0x07, 0x00, 0x00, // auipc x15, 0 — current PC
  0x93, 0x87, 0xc7, 0x0d, // addi x15, x15, 220 — handler address
  0x73, 0x90, 0x57, 0x30, // csrrw x0, mtvec, x15 — Direct mode
  0x23, 0xa8, 0x05, 0x04, // sw   x0, 0x50(x11) — QueueNotify (the one kick)
  0x93, 0x02, 0x00, 0x00, // addi x5, x0, 0 — counter = 0
  0x13, 0x03, 0xa0, 0x02, // addi x6, x0, 42 — loop count
  0x93, 0x82, 0x12, 0x00, // addi x5, x5, 1 — increment counter
  0x13, 0x03, 0xf3, 0xff, // addi x6, x6, -1 — decrement loop
  0xe3, 0x1c, 0x03, 0xfe, // bne  x6, x0, counter_loop — pure-register loop
  0x23, 0x30, 0x57, 0x70, // sd   x5, 0x700(x14) — store counter
  0x23, 0x00, 0x55, 0x00, // sb   x5, 0(x10) — print counter (42 = '*')
  0x13, 0x03, 0xa0, 0x02, // addi x6, x0, 42 — expected N
  0x63, 0x90, 0x62, 0x0e, // bne  x5, x6, fail — counter mismatch
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — MEIE bit mask
  0x93, 0x97, 0xb7, 0x00, // slli x15, x15, 11 — MEIE (bit 11)
  0x73, 0xa0, 0x47, 0x30, // csrrs x0, mie, x15 — enable MEIE
  0x73, 0x60, 0x04, 0x30, // csrrsi x0, mstatus, 8 — enable MIE
  0x63, 0x14, 0x0a, 0x00, // bne  x20, x0, poll_done — handler ran?
  0x6f, 0xf0, 0xdf, 0xff, // jal  x0, poll — spin until the handler runs
  0x13, 0x03, 0x10, 0x00, // addi x6, x0, 1 — expected PLIC source
  0x63, 0x90, 0x6a, 0x0c, // bne  x21, x6, fail — PLIC source != 1
  0x13, 0x73, 0x1b, 0x00, // andi x6, x22, 1 — InterruptStatus bit 0
  0x63, 0x0c, 0x03, 0x0a, // beq  x6, x0, fail — InterruptStatus not set
  0x13, 0x03, 0x10, 0x00, // addi x6, x0, 1 — expected used.idx
  0x63, 0x98, 0x6b, 0x0a, // bne  x23, x6, fail — used.idx != 1
  0x63, 0x16, 0x0c, 0x0a, // bne  x24, x0, fail — used[0].id != 0
  0x13, 0x03, 0x00, 0x20, // addi x6, x0, 512 — expected used[0].len
  0x63, 0x92, 0x6c, 0x0a, // bne  x25, x6, fail — used[0].len != 512
  0x93, 0x03, 0x07, 0x30, // addi x7, x14, 0x300 — data buffer
  0x83, 0xc7, 0x03, 0x00, // lbu  x15, 0(x7) — data[0]
  0x13, 0x03, 0x50, 0x05, // addi x6, x0, 0x55 — expected data[0]
  0x63, 0x9a, 0x67, 0x08, // bne  x15, x6, fail — data[0] mismatch
  0x83, 0xc7, 0x13, 0x00, // lbu  x15, 1(x7) — data[1]
  0x13, 0x03, 0xa0, 0x0a, // addi x6, x0, 0xAA — expected data[1]
  0x63, 0x94, 0x67, 0x08, // bne  x15, x6, fail — data[1] mismatch
  0x83, 0xc7, 0x23, 0x00, // lbu  x15, 2(x7) — data[2]
  0x13, 0x03, 0x20, 0x01, // addi x6, x0, 0x12 — expected data[2]
  0x63, 0x9e, 0x67, 0x06, // bne  x15, x6, fail — data[2] mismatch
  0x83, 0xc7, 0x33, 0x00, // lbu  x15, 3(x7) — data[3]
  0x13, 0x03, 0x40, 0x03, // addi x6, x0, 0x34 — expected data[3]
  0x63, 0x98, 0x67, 0x06, // bne  x15, x6, fail — data[3] mismatch
  0x93, 0x07, 0x00, 0x05, // addi x15, x0, 80 — 'P'
  0x23, 0x00, 0xf5, 0x00, // sb   x15, 0(x10) — print P
  0x93, 0x07, 0x10, 0x04, // addi x15, x0, 65 — 'A'
  0x23, 0x00, 0xf5, 0x00, // sb   x15, 0(x10) — print A
  0x93, 0x07, 0x30, 0x05, // addi x15, x0, 83 — 'S'
  0x23, 0x00, 0xf5, 0x00, // sb   x15, 0(x10) — print S
  0x93, 0x07, 0x30, 0x05, // addi x15, x0, 83 — 'S'
  0x23, 0x00, 0xf5, 0x00, // sb   x15, 0(x10) — print S
  0x83, 0x07, 0x55, 0x00, // lb   x15, 5(x10) — LSR
  0x93, 0xf7, 0x07, 0x04, // andi x15, x15, 64 — TEMT
  0xe3, 0x8c, 0x07, 0xfe, // beq  x15, x0, drain — spin until TX drained
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — poweroff value
  0x23, 0xa0, 0xf6, 0x00, // sw   x15, 0(x13) — syscon poweroff
  0x6f, 0x00, 0x00, 0x00, // jal  x0, 0 — yank-safe spin
  0x37, 0x03, 0x20, 0x00, // lui  x6, 0x200 — 0x200000
  0x33, 0x03, 0x66, 0x00, // add  x6, x12, x6 — claim addr
  0x83, 0x2a, 0x43, 0x00, // lw   x21, 4(x6) — claim M → source
  0x03, 0xab, 0x05, 0x06, // lw   x22, 0x60(x11) — InterruptStatus
  0x93, 0x07, 0x10, 0x00, // addi x15, x0, 1 — ack bit 0
  0x23, 0xa2, 0xf5, 0x06, // sw   x15, 0x64(x11) — InterruptACK
  0x93, 0x03, 0x07, 0x20, // addi x7, x14, 0x200 — used ring
  0x83, 0xdb, 0x23, 0x00, // lhu  x23, 2(x7) — used.idx
  0x03, 0xac, 0x43, 0x00, // lw   x24, 4(x7) — used[0].id
  0x83, 0xac, 0x83, 0x00, // lw   x25, 8(x7) — used[0].len
  0x23, 0x22, 0x53, 0x01, // sw   x21, 4(x6) — complete PLIC
  0x13, 0x0a, 0x10, 0x00, // addi x20, x0, 1 — handler ran
  0x73, 0x00, 0x20, 0x30, // mret — return from handler
  0x93, 0x07, 0x60, 0x04, // addi x15, x0, 70 — 'F'
  0x23, 0x00, 0xf5, 0x00, // sb   x15, 0(x10) — print F
  0x93, 0x07, 0x10, 0x04, // addi x15, x0, 65 — 'A'
  0x23, 0x00, 0xf5, 0x00, // sb   x15, 0(x10) — print A
  0x93, 0x07, 0x90, 0x04, // addi x15, x0, 73 — 'I'
  0x23, 0x00, 0xf5, 0x00, // sb   x15, 0(x10) — print I
  0x93, 0x07, 0xc0, 0x04, // addi x15, x0, 76 — 'L'
  0x23, 0x00, 0xf5, 0x00, // sb   x15, 0(x10) — print L
  0x6f, 0xf0, 0x5f, 0xf9, // jal  x0, drain — drain + poweroff
]);

// ─── Disk image (1024 bytes = 2 sectors, sector 0 starts with signature) ──────

const diskImage = new Uint8Array(1024);
diskImage[0] = 0x55;
diskImage[1] = 0xaa;
diskImage[2] = 0x12;
diskImage[3] = 0x34;

// ─── Boot harness for virtio-enabled guests ───────────────────────────────────

const guestRegions = (): Map<
  string,
  { guestAddress: ReadonlyUint8Array; guestByteLength: bigint }
> =>
  new Map([
    [RAM_REGION_ID, { guestAddress: guestAddress(RAM_BASE), guestByteLength: RAM_BYTE_LENGTH }],
    [
      UART_REGION_ID,
      { guestAddress: guestAddress(0x1000_0000n), guestByteLength: UART_GUEST_BYTE_LENGTH },
    ],
    [
      CLINT_REGION_ID,
      { guestAddress: guestAddress(0x0200_0000n), guestByteLength: CLINT_GUEST_BYTE_LENGTH },
    ],
    [
      PLIC_REGION_ID,
      { guestAddress: guestAddress(0x0c00_0000n), guestByteLength: PLIC_GUEST_BYTE_LENGTH },
    ],
    [
      SYSCON_REGION_ID,
      { guestAddress: guestAddress(0x0010_0000n), guestByteLength: SYSCON_GUEST_BYTE_LENGTH },
    ],
    [
      VIRTIO_REGION_ID,
      {
        guestAddress: guestAddress(0x1000_1000n),
        guestByteLength: VIRTIO_GUEST_BYTE_LENGTH,
      },
    ],
  ]);

const runVirtioGuest = async (
  body: (context: { output: GuestOutput; emulator: EmulatorHandle }) => Promise<void>
): Promise<void> => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const output = collectOutput(stdout);
  const emulator = create({
    image: guestImage,
    diskImage,
    stdin,
    stdout,
    guestRegions: guestRegions(),
    resetPc: guestAddress(RAM_BASE),
    timebaseHz: TIMEBASE_HZ,
    deviceTreeAddress: 'end',
  });
  try {
    emulator.start();
    await body({ output, emulator });
  } finally {
    emulator.stop();
    await settleEmulator(emulator);
  }
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('virtio integration (real machine, no mocks)', () => {
  it('probes all guest image encodings through decode', () => {
    const memory = createTestMemory(256n * 1024n, 1024);
    assert.ok(memory.regions.has(VIRTIO_REGION_ID), 'test memory includes virtio region');
    for (let offset = 0; offset < guestImage.length; offset += 4) {
      const word = guestImage.subarray(offset, offset + 4) as ReadonlyUint8Array;
      const [thunk, length] = decode(word);
      assert.ok(typeof thunk === 'function', `offset ${offset}: decode returned non-function`);
      assert.deepEqual(length, FOUR_BYTES, `offset ${offset}: expected 4-byte instruction`);
    }
  });

  it(
    'boots, negotiates VirtIO v2, reads sector 0, and passes (3 consecutive runs)',
    { timeout: 60_000 },
    async () => {
      for (let run = 0; run < 3; run += 1) {
        await runVirtioGuest(async ({ output, emulator }) => {
          await Promise.race([
            output.waitForByteCount(EXPECTED_OUTPUT.length),
            settleEmulator(emulator),
          ]);
          const text = output.text();
          assert.equal(
            text,
            EXPECTED_OUTPUT,
            `run ${run + 1}/3: expected '${EXPECTED_OUTPUT}' but got ${JSON.stringify(text)}`
          );
          await settleEmulator(emulator);
          assert.equal(
            output.text(),
            EXPECTED_OUTPUT,
            `run ${run + 1}/3: extra UART bytes after syscon poweroff`
          );
        });
      }
    }
  );
});
