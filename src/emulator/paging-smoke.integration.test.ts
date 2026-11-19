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
  addi,
  andi,
  Assembler,
  CSR_MEPC,
  CSR_MSTATUS,
  CSR_MTVEC,
  CSR_PMPADDR0,
  CSR_PMPCFG0,
  CSR_SATP,
  add,
  beq,
  csrrw,
  lb,
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

describe('paging smoke integration', () => {
  it(
    'enters S-mode under Sv39 and reaches the translated UART path',
    { timeout: 10000 },
    async () => {
      const asm = new Assembler();
      asm.defineLabel('start');

      // PMP: NAPOT cover everything, RWX, unlocked.
      asm.emit({ emit: () => addi(5, 0, -1n), comment: 'x5 = -1' });
      asm.emit({ emit: () => srli(5, 5, 2n), comment: 'x5 = 0x3fffffffffffffff-ish' });
      asm.emit({ emit: () => csrrw(0, CSR_PMPADDR0, 5), comment: 'pmpaddr0 = match-all' });
      asm.emit({ emit: () => addi(5, 0, 0x1fn), comment: 'RWX NAPOT' });
      asm.emit({ emit: () => csrrw(0, CSR_PMPCFG0, 5), comment: 'pmpcfg0 = RWX NAPOT' });

      // mtvec: simplest possible handler (spin).
      asm.emit({
        emit: (labels) => addi(5, 0, BigInt(labels.get('mtvec_handler')!)),
        comment: 'mtvec_handler offset',
      });
      asm.emit({ emit: () => addi(14, 0, 1n), comment: 'x14 = 1' });
      asm.emit({ emit: () => slli(14, 14, 31n), comment: 'x14 = 0x8000_0000' });
      asm.emit({ emit: () => add(14, 14, 5), comment: 'x14 = mtvec physical address' });
      asm.emit({ emit: () => csrrw(0, CSR_MTVEC, 14), comment: 'mtvec = handler' });

      // mepc: full VA of s_entry.
      asm.emit({
        emit: (labels) => addi(5, 0, BigInt(labels.get('s_entry')!)),
        comment: 's_entry offset',
      });
      asm.emit({ emit: () => addi(14, 0, 1n), comment: 'x14 = 1' });
      asm.emit({ emit: () => slli(14, 14, 31n), comment: 'x14 = 0x8000_0000' });
      asm.emit({ emit: () => add(14, 14, 5), comment: 'x14 = s_entry VA' });
      asm.emit({ emit: () => csrrw(0, CSR_MEPC, 14), comment: 'mepc = s_entry VA' });

      // mstatus: MPP=S (0x08 in byte 1), MPIE=1 (0x80 in byte 0) → 0x0880.
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

      // Enter S-mode via mret (MPP=S → privilege S, PC ← mepc).
      asm.emit({ emit: () => mret(), comment: 'enter S-mode at mepc' });

      // M-mode trap handler: spin forever.
      asm.defineLabel('mtvec_handler');
      asm.emit({ emit: () => addi(5, 0, 0n), comment: 'x5 = 0' });
      asm.emit({
        emit: (labels, myOff) => beq(5, 0, BigInt(labels.get('mtvec_handler')! - myOff)),
        comment: 'spin',
      });

      // S-mode entry: print 'K' through translated UART mapping.
      asm.defineLabel('s_entry');
      asm.emit({ emit: () => lui(10, 0x10000n), comment: 'x10 = UART base' });
      asm.emit({ emit: () => addi(12, 0, 75n), comment: "'K'" });
      asm.emit({ emit: () => sb(10, 12, 0n), comment: 'print K' });

      // Drain UART TX, then power off via syscon.
      asm.defineLabel('drain');
      asm.emit({ emit: () => lb(11, 10, 5n), comment: 'x11 = LSR' });
      asm.emit({ emit: () => andi(11, 11, 64n), comment: 'x11 &= TEMT' });
      asm.emit({
        emit: (labels, myOff) => beq(11, 0, BigInt(labels.get('drain')! - myOff)),
        comment: 'wait for TEMT',
      });
      asm.emit({ emit: () => lui(12, 0x100n), comment: 'x12 = syscon base (0x0010_0000)' });
      asm.emit({ emit: () => addi(14, 0, 1n), comment: 'x14 = 1' });
      asm.emit({ emit: () => sw(12, 14, 0n), comment: 'syscon poweroff' });
      asm.emit({ emit: () => lui(0, 0n), comment: 'yank-safe spin' });

      const image = new Uint8Array(IMAGE_SIZE);
      image.set(asm.assemble());

      // Sv39 page tables:
      // - low devices (UART/syscon) via L2[0] -> L1_LOW -> L0_LOW
      // - code/data (0x8000_0000...) via L2[2] -> L1 -> L0
      writePte(image, OFF_L2 + 2 * 8, ptrPte(PPN_L1));
      writePte(image, OFF_L2, ptrPte(PPN_L1_LOW));
      writePte(image, OFF_L1, ptrPte(PPN_L0));
      writePte(image, OFF_L1_LOW, ptrPte(PPN_L0_LOW));
      writePte(
        image,
        OFF_L1_LOW + 128 * 8,
        leafPte(PPN_UART, PTE_V | PTE_R | PTE_W | PTE_A | PTE_D)
      );
      writePte(image, OFF_L0, leafPte(PPN_CODE, PTE_V | PTE_R | PTE_X | PTE_A));
      writePte(
        image,
        OFF_L0_LOW + 256 * 8,
        leafPte(PPN_SYSCON, PTE_V | PTE_R | PTE_W | PTE_A | PTE_D)
      );

      await runGuest(image, async ({ output, emulator }) => {
        await expectPrintThenPoweroff(output, emulator, 'K');
      });
    }
  );
});
