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
import { addi, andi, Assembler, beq, lb, lui, sb, sw } from '#test/assembler';

describe('basic print integration (no paging)', () => {
  it('prints A and powers off via physical UART', { timeout: 10000 }, async () => {
    const asm = new Assembler();
    asm.defineLabel('start');

    // Store 'A' to UART via physical mapping.
    asm.emit({ emit: () => lui(10, 0x10000n), comment: 'x10 = UART base (0x1000_0000)' });
    asm.emit({ emit: () => addi(11, 0, 65n), comment: "'A'" });
    asm.emit({ emit: () => sb(10, 11, 0n), comment: 'UART[0] = A' });

    // Drain UART TX, then power off via syscon.
    asm.defineLabel('drain');
    asm.emit({ emit: () => lb(12, 10, 5n), comment: 'x12 = LSR' });
    asm.emit({ emit: () => andi(12, 12, 64n), comment: 'x12 &= TEMT (0x40)' });
    asm.emit({
      emit: (labels, myOff) => beq(12, 0, BigInt(labels.get('drain')! - myOff)),
      comment: 'loop while TEMT == 0',
    });

    // Syscon poweroff.
    asm.emit({ emit: () => lui(14, 0x100n), comment: 'x14 = syscon base (0x0010_0000)' });
    asm.emit({ emit: () => addi(15, 0, 1n), comment: 'x15 = 1' });
    asm.emit({ emit: () => sw(14, 15, 0n), comment: 'syscon[0] = poweroff' });

    // Yank-safe spin.
    asm.defineLabel('spin');
    asm.emit({
      emit: (labels, myOff) => addi(0, 0, BigInt(labels.get('spin')! - myOff)),
      comment: 'spin forever (addi x0,x0,0 is a no-op, loops here)',
    });

    const image = asm.assemble();
    await runGuest(image, async ({ output, emulator }) => {
      await expectPrintThenPoweroff(output, emulator, 'A');
    });
  });
});
