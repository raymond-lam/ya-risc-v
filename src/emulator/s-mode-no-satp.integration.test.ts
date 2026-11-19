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
  Assembler,
  beq,
  CSR_MEPC,
  CSR_MSTATUS,
  CSR_PMPCFG0,
  CSR_PMPADDR0,
  csrrw,
  lb,
  lui,
  mret,
  sb,
  slli,
  srli,
  sw,
} from '#test/assembler';

describe('S-mode entry without satp (no paging)', () => {
  it('enters S-mode via mret and prints K via physical UART', { timeout: 10000 }, async () => {
    const asm = new Assembler();
    asm.defineLabel('start');

    // PMP: NAPOT cover everything, RWX, unlocked.
    asm.emit({ emit: () => addi(5, 0, -1n), comment: 'x5 = -1' });
    asm.emit({ emit: () => srli(5, 5, 2n), comment: 'x5 = 0x3fffffffffffffff' });
    asm.emit({ emit: () => csrrw(0, CSR_PMPADDR0, 5), comment: 'pmpaddr0 = match-all' });
    asm.emit({ emit: () => addi(5, 0, 0x1fn), comment: 'RWX NAPOT' });
    asm.emit({ emit: () => csrrw(0, CSR_PMPCFG0, 5), comment: 'pmpcfg0 = RWX NAPOT' });

    // mepc: set to s_entry (full physical address = 0x8000_0000 + offset).
    asm.emit({ emit: () => addi(14, 0, 1n), comment: 'x14 = 1' });
    asm.emit({ emit: () => slli(14, 14, 31n), comment: 'x14 = 0x8000_0000' });
    asm.emit({
      emit: (labels) => addi(5, 0, BigInt(labels.get('s_entry')!)),
      comment: 's_entry offset',
    });
    asm.emit({ emit: () => add(14, 14, 5), comment: 'x14 = RAM base + offset' });
    asm.emit({ emit: () => csrrw(0, CSR_MEPC, 14), comment: 'mepc = full physical address' });

    // mstatus: MPP=S (byte1 bits 4:3 = 01 → 0x08), MPIE=1 (byte0 bit 7 = 0x80).
    // LE value = 0x08*256 + 0x80 = 0x0880. Build with lui+addi.
    asm.emit({ emit: () => lui(5, 0x1n), comment: 'x5 = 0x1000' });
    asm.emit({ emit: () => addi(5, 5, -0x780n), comment: 'x5 = 0x0880 (MPIE | MPP=S)' });
    asm.emit({ emit: () => csrrw(0, CSR_MSTATUS, 5), comment: 'mstatus = MPIE | MPP=S' });

    // Enter S-mode via mret (MPP=S → privilege S, PC ← mepc).
    asm.emit({ emit: () => mret(), comment: 'enter S-mode at mepc' });

    // S-mode entry: print 'K' through physical UART, then poweroff.
    asm.defineLabel('s_entry');
    asm.emit({ emit: () => lui(10, 0x10000n), comment: 'x10 = UART base' });
    asm.emit({ emit: () => addi(12, 0, 75n), comment: "'K'" });
    asm.emit({ emit: () => sb(10, 12, 0n), comment: 'print K' });

    // Syscon poweroff (skip UART drain for simple test).
    asm.emit({ emit: () => lui(14, 0x100n), comment: 'x14 = syscon base' });
    asm.emit({ emit: () => addi(15, 0, 1n), comment: 'x15 = 1' });
    asm.emit({ emit: () => sw(14, 15, 0n), comment: 'syscon poweroff' });

    // Yank-safe spin.
    asm.defineLabel('spin');
    asm.emit({
      emit: (labels, myOff) => beq(0, 0, BigInt(labels.get('spin')! - myOff)),
      comment: 'spin forever',
    });

    const image = asm.assemble();
    await runGuest(image, async ({ output, emulator }) => {
      await expectPrintThenPoweroff(output, emulator, 'K');
    });
  });
});
