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

import { describe, it } from 'node:test';
import { expectPrintThenPoweroff, runGuest } from '#test/integration-harness';
import {
  add,
  addi,
  andi,
  Assembler,
  beq,
  CSR_MEPC,
  CSR_MEDELEG,
  CSR_MENVCFG,
  CSR_MSTATUS,
  CSR_PMPCFG0,
  CSR_PMPADDR0,
  CSR_SATP,
  CSR_SCAUSE,
  CSR_STVEC,
  csrrs,
  csrrw,
  lb,
  ld,
  lui,
  mret,
  or_,
  sb,
  slli,
  srli,
  sw,
  writePte,
} from '#test/assembler';

const IMAGE_SIZE = 0x10000;
const OFF_L2 = 0x1000;
const OFF_L1 = 0x2000;
const OFF_L0 = 0x3000;
const OFF_L1_LOW = 0x4000;
const OFF_L0_LOW = 0x5000;

const PTE_V = 1n;
const PTE_R = 2n;
const PTE_W = 4n;
const PTE_X = 8n;
const PTE_A = 64n;
const PTE_D = 128n;

const leafPte = (ppn: bigint, flags: bigint): bigint => (ppn << 10n) | flags;
const ptrPte = (ppn: bigint): bigint => (ppn << 10n) | PTE_V;

const PPN_L2 = 0x80001n;
const PPN_L1 = 0x80002n;
const PPN_L0 = 0x80003n;
const PPN_L1_LOW = 0x80004n;
const PPN_L0_LOW = 0x80005n;
const PPN_CODE = 0x80000n;
const PPN_SYSCON = 0x100n;
const PPN_UART = 0x10000n;

// Page table setup: common function for all tests
const setupSv39PageTables = (image: Uint8Array): void => {
  // Low devices (UART/syscon) via L2[0] -> L1_LOW -> L0_LOW
  writePte(image, OFF_L2, ptrPte(PPN_L1_LOW));
  writePte(image, OFF_L1_LOW, ptrPte(PPN_L0_LOW));
  writePte(image, OFF_L1_LOW + 128 * 8, leafPte(PPN_UART, PTE_V | PTE_R | PTE_W | PTE_A | PTE_D));
  writePte(image, OFF_L0_LOW + 256 * 8, leafPte(PPN_SYSCON, PTE_V | PTE_R | PTE_W | PTE_A | PTE_D));

  // Code/data (0x8000_0000...) via L2[2] -> L1 -> L0
  writePte(image, OFF_L2 + 2 * 8, ptrPte(PPN_L1));
  writePte(image, OFF_L1, ptrPte(PPN_L0));
  writePte(image, OFF_L0, leafPte(PPN_CODE, PTE_V | PTE_R | PTE_X | PTE_A));
};

describe('paging integration', () => {
  it('translated store/load round-trip through mapped data page', { timeout: 10000 }, async () => {
    const asm = new Assembler();
    asm.defineLabel('start');

    // PMP: NAPOT cover everything, RWX, unlocked.
    asm.emit({ emit: () => addi(5, 0, -1n), comment: 'x5 = -1' });
    asm.emit({ emit: () => srli(5, 5, 2n), comment: 'x5 = 0x3fffffffffffffff' });
    asm.emit({ emit: () => csrrw(0, CSR_PMPADDR0, 5), comment: 'pmpaddr0 = match-all' });
    asm.emit({ emit: () => addi(5, 0, 0x1fn), comment: 'RWX NAPOT' });
    asm.emit({ emit: () => csrrw(0, CSR_PMPCFG0, 5), comment: 'pmpcfg0 = RWX NAPOT' });

    // mepc: full VA of s_entry.
    asm.emit({ emit: () => addi(14, 0, 1n), comment: 'x14 = 1' });
    asm.emit({ emit: () => slli(14, 14, 31n), comment: 'x14 = 0x8000_0000' });
    asm.emit({
      emit: (labels) => addi(5, 0, BigInt(labels.get('s_entry')!)),
      comment: 's_entry offset',
    });
    asm.emit({ emit: () => add(14, 14, 5), comment: 'x14 = s_entry VA' });
    asm.emit({ emit: () => csrrw(0, CSR_MEPC, 14), comment: 'mepc = s_entry VA' });

    // mstatus: MPP=S, MPIE=1.
    asm.emit({ emit: () => lui(5, 0x1n), comment: 'x5 = 0x1000' });
    asm.emit({ emit: () => addi(5, 5, -0x780n), comment: 'x5 = 0x0880 (MPIE | MPP=S)' });
    asm.emit({ emit: () => csrrw(0, CSR_MSTATUS, 5), comment: 'mstatus = MPIE | MPP=S' });

    // satp: Sv39 mode, root table at PA 0x8000_1000 (PPN 0x80001).
    asm.emit({ emit: () => addi(5, 0, 8n), comment: 'x5 = Sv39 mode' });
    asm.emit({ emit: () => slli(5, 5, 60n), comment: 'x5 = 8 << 60' });
    asm.emit({ emit: () => lui(6, 0x80n), comment: 'x6 = 0x0008_0000' });
    asm.emit({ emit: () => addi(6, 6, 1n), comment: 'x6 = PPN 0x80001' });
    asm.emit({ emit: () => or_(5, 5, 6), comment: 'satp value' });
    asm.emit({ emit: () => csrrw(0, CSR_SATP, 5), comment: 'satp = Sv39 | root PPN' });

    asm.emit({ emit: () => mret(), comment: 'enter S-mode at mepc' });

    // S-mode entry: store canary 0x42, load back, print loaded value, poweroff.
    // Host will assert output is 'C' (ASCII 0x42 = 67).
    asm.defineLabel('s_entry');
    // Build data VA 0x8000_2000
    asm.emit({ emit: () => addi(14, 0, 1n), comment: 'x14 = 1' });
    asm.emit({ emit: () => slli(14, 14, 31n), comment: 'x14 = 0x8000_0000' });
    // Add 0x2000 via: x15 = 2, slli 12, add
    asm.emit({ emit: () => addi(15, 0, 2n), comment: 'x15 = 2' });
    asm.emit({ emit: () => slli(15, 15, 12n), comment: 'x15 = 0x2000' });
    asm.emit({ emit: () => add(14, 14, 15), comment: 'x14 = 0x8000_2000 (data VA)' });

    // Store canary (0x42 = 'C') to data page via translation
    asm.emit({ emit: () => addi(15, 0, 0x42n), comment: 'x15 = canary 0x42' });
    asm.emit({ emit: () => sw(14, 15, 0n), comment: 'store canary via translation' });

    // Load canary back and print
    asm.emit({ emit: () => lb(15, 14, 0n), comment: 'x15 = load canary' });
    asm.emit({ emit: () => lui(10, 0x10000n), comment: 'x10 = UART base' });
    asm.emit({ emit: () => sb(10, 15, 0n), comment: 'print loaded value (should be C)' });

    // Drain UART TX, then power off via syscon.
    asm.defineLabel('drain');
    asm.emit({ emit: () => lb(11, 10, 5n), comment: 'x11 = LSR' });
    asm.emit({ emit: () => andi(11, 11, 64n), comment: 'x11 &= TEMT' });
    asm.emit({
      emit: (labels, myOff) => beq(11, 0, BigInt(labels.get('drain')! - myOff)),
      comment: 'wait for TEMT',
    });

    // Syscon poweroff.
    asm.emit({ emit: () => lui(12, 0x100n), comment: 'x12 = syscon base (0x0010_0000)' });
    asm.emit({ emit: () => addi(15, 0, 1n), comment: 'x15 = 1' });
    asm.emit({ emit: () => sw(12, 15, 0n), comment: 'syscon poweroff' });
    asm.emit({ emit: () => lui(0, 0n), comment: 'yank-safe spin' });

    const image = new Uint8Array(IMAGE_SIZE);
    image.set(asm.assemble());

    // Setup page tables
    setupSv39PageTables(image);

    // Add mapping for data page: VA 0x8000_2000 -> PA 0x8000_6000
    const dataVpn = 0x8000_2000n >> 12n;
    const dataPpn = 0x8000_6000n >> 12n;
    const dataPteOffset = Number(BigInt(OFF_L0) + (dataVpn & 0x1ffn) * 8n);
    writePte(image, dataPteOffset, leafPte(dataPpn, PTE_V | PTE_R | PTE_W | PTE_A | PTE_D));

    await runGuest(image, async ({ output, emulator }) => {
      await expectPrintThenPoweroff(output, emulator, 'B');
    });
  });

  it(
    'delegated store page fault: unmapped store traps to S-mode with scause=15',
    { timeout: 10000 },
    async () => {
      const asm = new Assembler();
      asm.defineLabel('start');

      // PMP: NAPOT cover everything, RWX, unlocked.
      asm.emit({ emit: () => addi(5, 0, -1n), comment: 'x5 = -1' });
      asm.emit({ emit: () => srli(5, 5, 2n), comment: 'x5 = 0x3fffffffffffffff' });
      asm.emit({ emit: () => csrrw(0, CSR_PMPADDR0, 5), comment: 'pmpaddr0 = match-all' });
      asm.emit({ emit: () => addi(5, 0, 0x1fn), comment: 'RWX NAPOT' });
      asm.emit({ emit: () => csrrw(0, CSR_PMPCFG0, 5), comment: 'pmpcfg0 = RWX NAPOT' });

      // Delegate store/AMO page fault to S-mode (bit 15 in medeleg).
      asm.emit({ emit: () => addi(5, 0, 1n), comment: 'x5 = 1' });
      asm.emit({ emit: () => slli(5, 5, 15n), comment: 'x5 = 1 << 15 (0x8000)' });
      asm.emit({
        emit: () => csrrw(0, CSR_MEDELEG, 5),
        comment: 'medeleg = bit 15 (store page fault)',
      });

      // stvec: S-mode trap handler prints '!' then scause low nibble, then poweroff.
      asm.emit({ emit: () => addi(14, 0, 1n), comment: 'x14 = 1' });
      asm.emit({ emit: () => slli(14, 14, 31n), comment: 'x14 = 0x8000_0000' });
      asm.emit({
        emit: (labels) => addi(5, 0, BigInt(labels.get('s_trap')!)),
        comment: 's_trap offset',
      });
      asm.emit({ emit: () => add(14, 14, 5), comment: 'x14 = s_trap PA' });
      asm.emit({ emit: () => csrrw(0, CSR_STVEC, 14), comment: 'stvec = s_trap' });

      // mepc: full VA of s_entry.
      asm.emit({ emit: () => addi(14, 0, 1n), comment: 'x14 = 1' });
      asm.emit({ emit: () => slli(14, 14, 31n), comment: 'x14 = 0x8000_0000' });
      asm.emit({
        emit: (labels) => addi(5, 0, BigInt(labels.get('s_entry')!)),
        comment: 's_entry offset',
      });
      asm.emit({ emit: () => add(14, 14, 5), comment: 'x14 = s_entry VA' });
      asm.emit({ emit: () => csrrw(0, CSR_MEPC, 14), comment: 'mepc = s_entry VA' });

      // mstatus: MPP=S, MPIE=1.
      asm.emit({ emit: () => lui(5, 0x1n), comment: 'x5 = 0x1000' });
      asm.emit({ emit: () => addi(5, 5, -0x780n), comment: 'x5 = 0x0880 (MPIE | MPP=S)' });
      asm.emit({ emit: () => csrrw(0, CSR_MSTATUS, 5), comment: 'mstatus = MPIE | MPP=S' });

      // satp: Sv39 mode, root table at PA 0x8000_1000.
      asm.emit({ emit: () => addi(5, 0, 8n), comment: 'x5 = Sv39 mode' });
      asm.emit({ emit: () => slli(5, 5, 60n), comment: 'x5 = 8 << 60' });
      asm.emit({ emit: () => lui(6, 0x80n), comment: 'x6 = 0x0008_0000' });
      asm.emit({ emit: () => addi(6, 6, 1n), comment: 'x6 = PPN 0x80001' });
      asm.emit({ emit: () => or_(5, 5, 6), comment: 'satp value' });
      asm.emit({ emit: () => csrrw(0, CSR_SATP, 5), comment: 'satp = Sv39 | root PPN' });

      asm.emit({ emit: () => mret(), comment: 'enter S-mode at mepc' });

      // S-mode entry: store to unmapped VA 0x8000_3000 to trigger page fault.
      asm.defineLabel('s_entry');
      // Build VA 0x8000_3000: 0x8000_0000 + 0x3000 = 3 * 0x1000
      asm.emit({ emit: () => addi(14, 0, 1n), comment: 'x14 = 1' });
      asm.emit({ emit: () => slli(14, 14, 31n), comment: 'x14 = 0x8000_0000' });
      asm.emit({ emit: () => lui(15, 0x3n), comment: 'x15 = 0x3 (page number)' });
      asm.emit({ emit: () => slli(15, 15, 12n), comment: 'x15 = 0x3000' });
      asm.emit({ emit: () => add(14, 14, 15), comment: 'x14 = 0x8000_3000 (unmapped)' });
      asm.emit({ emit: () => addi(15, 0, 0x11n), comment: 'x15 = 0x11' });
      asm.emit({ emit: () => sw(14, 15, 0n), comment: 'store to unmapped (traps)' });

      // S-mode trap handler: print '!' then scause low 4 bits as hex digit, then poweroff.
      // Host will assert output is "!f" (scause=15 -> 0xf).
      asm.defineLabel('s_trap');
      asm.emit({ emit: () => lui(10, 0x10000n), comment: 'x10 = UART base' });
      asm.emit({ emit: () => addi(12, 0, 33n), comment: "'!'" });
      asm.emit({ emit: () => sb(10, 12, 0n), comment: 'print !' });

      // Print scause low 4 bits as hex digit
      asm.emit({ emit: () => csrrs(5, CSR_SCAUSE, 0), comment: 'x5 = scause' });
      asm.emit({ emit: () => andi(5, 5, 0xfn), comment: 'x5 = scause & 0xf' });
      asm.emit({ emit: () => addi(5, 5, 87n), comment: 'x5 += 87 for hex (0-9 -> 0-f)' });
      asm.emit({ emit: () => sb(10, 5, 0n), comment: 'print hex digit' });

      // Drain UART TX, then power off via syscon.
      asm.defineLabel('drain');
      asm.emit({ emit: () => lb(11, 10, 5n), comment: 'x11 = LSR' });
      asm.emit({ emit: () => andi(11, 11, 64n), comment: 'x11 &= TEMT' });
      asm.emit({
        emit: (labels, myOff) => beq(11, 0, BigInt(labels.get('drain')! - myOff)),
        comment: 'wait for TEMT',
      });

      // Syscon poweroff.
      asm.emit({ emit: () => lui(12, 0x100n), comment: 'x12 = syscon base (0x0010_0000)' });
      asm.emit({ emit: () => addi(15, 0, 1n), comment: 'x15 = 1' });
      asm.emit({ emit: () => sw(12, 15, 0n), comment: 'syscon poweroff' });
      asm.emit({ emit: () => lui(0, 0n), comment: 'yank-safe spin' });

      const image = new Uint8Array(IMAGE_SIZE);
      image.set(asm.assemble());

      // Setup page tables (no mapping for 0x8000_3000)
      setupSv39PageTables(image);

      await runGuest(image, async ({ output, emulator }) => {
        await expectPrintThenPoweroff(output, emulator, '!f');
      });
    }
  );

  it(
    'ADUE A/D update: store through PTE with A/D clear sets both bits',
    { timeout: 10000 },
    async () => {
      const asm = new Assembler();
      asm.defineLabel('start');

      // PMP: NAPOT cover everything, RWX, unlocked.
      asm.emit({ emit: () => addi(5, 0, -1n), comment: 'x5 = -1' });
      asm.emit({ emit: () => srli(5, 5, 2n), comment: 'x5 = 0x3fffffffffffffff' });
      asm.emit({ emit: () => csrrw(0, CSR_PMPADDR0, 5), comment: 'pmpaddr0 = match-all' });
      asm.emit({ emit: () => addi(5, 0, 0x1fn), comment: 'RWX NAPOT' });
      asm.emit({ emit: () => csrrw(0, CSR_PMPCFG0, 5), comment: 'pmpcfg0 = RWX NAPOT' });

      // Enable menvcfg.ADUE (bit 61 = byte7 bit5 = 0x20 << 56)
      asm.emit({ emit: () => addi(5, 0, 0x20n), comment: 'x5 = 0x20 (ADUE in byte7)' });
      asm.emit({ emit: () => slli(5, 5, 56n), comment: 'x5 = 0x20 << 56 (ADUE bit 61)' });
      asm.emit({ emit: () => csrrw(0, CSR_MENVCFG, 5), comment: 'menvcfg = ADUE=1' });

      // mepc: full VA of s_entry.
      asm.emit({ emit: () => addi(14, 0, 1n), comment: 'x14 = 1' });
      asm.emit({ emit: () => slli(14, 14, 31n), comment: 'x14 = 0x8000_0000' });
      asm.emit({
        emit: (labels) => addi(5, 0, BigInt(labels.get('s_entry')!)),
        comment: 's_entry offset',
      });
      asm.emit({ emit: () => add(14, 14, 5), comment: 'x14 = s_entry VA' });
      asm.emit({ emit: () => csrrw(0, CSR_MEPC, 14), comment: 'mepc = s_entry VA' });

      // mstatus: MPP=S, MPIE=1.
      asm.emit({ emit: () => lui(5, 0x1n), comment: 'x5 = 0x1000' });
      asm.emit({ emit: () => addi(5, 5, -0x780n), comment: 'x5 = 0x0880 (MPIE | MPP=S)' });
      asm.emit({ emit: () => csrrw(0, CSR_MSTATUS, 5), comment: 'mstatus = MPIE | MPP=S' });

      // satp: Sv39 mode, root table at PA 0x8000_1000.
      asm.emit({ emit: () => addi(5, 0, 8n), comment: 'x5 = Sv39 mode' });
      asm.emit({ emit: () => slli(5, 5, 60n), comment: 'x5 = 8 << 60' });
      asm.emit({ emit: () => lui(6, 0x80n), comment: 'x6 = 0x0008_0000' });
      asm.emit({ emit: () => addi(6, 6, 1n), comment: 'x6 = PPN 0x80001' });
      asm.emit({ emit: () => or_(5, 5, 6), comment: 'satp value' });
      asm.emit({ emit: () => csrrw(0, CSR_SATP, 5), comment: 'satp = Sv39 | root PPN' });

      asm.emit({ emit: () => mret(), comment: 'enter S-mode at mepc' });

      // S-mode entry: store through PTE with A/D clear to trigger ADUE, then print marker.
      // Host will assert output is "A" (store completed successfully).
      asm.defineLabel('s_entry');
      // Build data VA 0x8000_7000
      asm.emit({ emit: () => addi(14, 0, 1n), comment: 'x14 = 1' });
      asm.emit({ emit: () => slli(14, 14, 31n), comment: 'x14 = 0x8000_0000' });
      // Add 0x7000 via: x15 = 7, slli 12, add
      asm.emit({ emit: () => addi(15, 0, 7n), comment: 'x15 = 7' });
      asm.emit({ emit: () => slli(15, 15, 12n), comment: 'x15 = 0x7000' });
      asm.emit({ emit: () => add(14, 14, 15), comment: 'x14 = 0x8000_7000 (data VA)' });

      // Store to trigger A/D update (no page fault if ADUE enabled)
      asm.emit({ emit: () => addi(15, 0, 0x33n), comment: 'x15 = 0x33' });
      asm.emit({ emit: () => sw(14, 15, 0n), comment: 'store triggers A/D set' });

      // Print marker to confirm store completed
      asm.emit({ emit: () => lui(10, 0x10000n), comment: 'x10 = UART base' });
      asm.emit({ emit: () => addi(15, 0, 65n), comment: "'A'" });
      asm.emit({ emit: () => sb(10, 15, 0n), comment: 'print A (success)' });

      // Drain UART TX, then power off via syscon.
      asm.defineLabel('drain');
      asm.emit({ emit: () => lb(11, 10, 5n), comment: 'x11 = LSR' });
      asm.emit({ emit: () => andi(11, 11, 64n), comment: 'x11 &= TEMT' });
      asm.emit({
        emit: (labels, myOff) => beq(11, 0, BigInt(labels.get('drain')! - myOff)),
        comment: 'wait for TEMT',
      });

      // Syscon poweroff.
      asm.emit({ emit: () => lui(12, 0x100n), comment: 'x12 = syscon base (0x0010_0000)' });
      asm.emit({ emit: () => addi(15, 0, 1n), comment: 'x15 = 1' });
      asm.emit({ emit: () => sw(12, 15, 0n), comment: 'syscon poweroff' });
      asm.emit({ emit: () => lui(0, 0n), comment: 'yank-safe spin' });

      const image = new Uint8Array(IMAGE_SIZE);
      image.set(asm.assemble());

      // Setup page tables
      setupSv39PageTables(image);

      // Add mapping for data page at 0x8000_7000 with A/D clear (only V|R|W set)
      const dataVpn = 0x8000_7000n >> 12n;
      const dataPpn = 0x8000_6000n >> 12n;
      const dataPteOffset = Number(BigInt(OFF_L0) + (dataVpn & 0x1ffn) * 8n);
      // PTE without A/D initially
      writePte(image, dataPteOffset, leafPte(dataPpn, PTE_V | PTE_R | PTE_W));

      await runGuest(image, async ({ output, emulator }) => {
        await expectPrintThenPoweroff(output, emulator, 'A');
      });
    }
  );
});
