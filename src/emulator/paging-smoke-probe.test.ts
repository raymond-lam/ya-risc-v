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
import { createMemory, storeBytes, loadBytes } from '#emulator/memory';
import { machineRegionSpecs } from '#test/guest-memory';
import {
  createRegisters,
  setPrivilegeMode,
  PRIVILEGE_SUPERVISOR,
  setProgramCounter,
  SATP,
  writeControlAndStatusRegister,
} from '#emulator/cpu/registers';
import { fetchTranslatedInstruction, prepareStoreAccess } from '#emulator/cpu/paging';
import { bytesToBigInt, unsignedBigIntToBytes } from '#utils/bytes';
import { writePte } from '#test/assembler';

const PTE_V = 1n;
const PTE_R = 2n;
const PTE_W = 4n;
const PTE_X = 8n;
const PTE_A = 64n;
const PTE_D = 128n;
const leafPte = (ppn: bigint, flags: bigint): bigint => (ppn << 10n) | flags;
const ptrPte = (ppn: bigint): bigint => (ppn << 10n) | PTE_V;
const PPN_L1 = 0x80002n;
const PPN_L0 = 0x80003n;
const PPN_L1_LOW = 0x80004n;
const PPN_L0_LOW = 0x80005n;
const PPN_CODE = 0x80000n;
const PPN_SYSCON = 0x100n;
const PPN_UART = 0x10000n;

const makeMemory = () =>
  createMemory(
    machineRegionSpecs({
      ramBaseAddress: unsignedBigIntToBytes(new Uint8Array(8), 0x80000000n),
      ramSize: 0x10000n,
      uartBaseAddress: unsignedBigIntToBytes(new Uint8Array(8), 0x10000000n),
      clintBaseAddress: unsignedBigIntToBytes(new Uint8Array(8), 0x02000000n),
      plicBaseAddress: unsignedBigIntToBytes(new Uint8Array(8), 0x0c000000n),
    })
  );

const setupPmp = (registers: ReturnType<typeof createRegisters>) => {
  writeControlAndStatusRegister(
    registers,
    0x3b0,
    unsignedBigIntToBytes(new Uint8Array(8), 0x3fffffffffffffn)
  );
  writeControlAndStatusRegister(registers, 0x3a0, unsignedBigIntToBytes(new Uint8Array(8), 0x1fn));
};

describe('paging smoke probe', () => {
  it('fetches code through 3-level mapping', async () => {
    const memory = makeMemory();
    const image = new Uint8Array(0x10000);
    writePte(image, 0x1000 + 2 * 8, ptrPte(PPN_L1));
    writePte(image, 0x1000, ptrPte(PPN_L1_LOW));
    writePte(image, 0x2000, ptrPte(PPN_L0));
    writePte(image, 0x4000, ptrPte(PPN_L0_LOW));
    writePte(image, 0x4000 + 128 * 8, leafPte(PPN_UART, PTE_V | PTE_R | PTE_W | PTE_A | PTE_D));
    writePte(image, 0x3000, leafPte(PPN_CODE, PTE_V | PTE_R | PTE_X | PTE_A));
    writePte(image, 0x3000 + 2 * 8, leafPte(0x80006n, PTE_V | PTE_R | PTE_W | PTE_A | PTE_D));
    writePte(image, 0x5000 + 256 * 8, leafPte(PPN_SYSCON, PTE_V | PTE_R | PTE_W | PTE_A | PTE_D));
    await storeBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x80000000n),
      source: image,
      byteLength: image.byteLength,
    });

    const registers = createRegisters();
    setupPmp(registers);
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    const satp = (8n << 60n) | 0x80001n;
    writeControlAndStatusRegister(registers, SATP, unsignedBigIntToBytes(new Uint8Array(8), satp));
    setProgramCounter(registers, unsignedBigIntToBytes(new Uint8Array(8), 0x800000d8n));
    const bytes = new Uint8Array(8);
    const result = await fetchTranslatedInstruction({ registers, memory, instructionBytes: bytes });
    console.log(
      'fetch result',
      result,
      'mcause',
      bytesToBigInt(registers.controlAndStatus[0x342]!),
      'mtval',
      bytesToBigInt(registers.controlAndStatus[0x343]!),
      'bytes',
      Array.from(bytes.slice(0, 4))
    );
    assert.equal(result, true);

    for (const [name, va, expected] of [
      ['syscon', 0x00100000n, 0x00100000n],
      ['uart', 0x10000000n, 0x10000000n],
      ['data', 0x80002000n, 0x80006000n],
    ] as const) {
      const r = await prepareStoreAccess({
        registers,
        memory,
        address: unsignedBigIntToBytes(new Uint8Array(8), va),
        byteLength: 4,
      });
      console.log(
        name,
        'denied',
        r.denied,
        'mcause',
        bytesToBigInt(registers.controlAndStatus[0x342]!)
      );
      assert.equal(r.denied, false);
      assert.equal(bytesToBigInt(r.physicalAddress), expected);
    }
  });
});
