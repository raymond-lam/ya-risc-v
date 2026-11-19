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
import testMemory from '#test/guest-memory';
import { fetchInstruction, fetchInstructionCycle } from '#emulator/cpu/run';
import {
  createRegisters,
  PRIVILEGE_MACHINE,
  PRIVILEGE_SUPERVISOR,
  SATP,
  setPrivilegeMode,
  setProgramCounter,
  writeControlAndStatusRegister,
} from '#emulator/cpu/registers';
import { CAUSE_INSTRUCTION_PAGE_FAULT, CAUSE_INSTRUCTION_ACCESS_FAULT } from '#emulator/cpu/trap';
import { bytesToNumber, unsignedBigIntToBytes } from '#utils/bytes';
import { storeBytes } from '#emulator/memory';
import { SATP_MODE_SV39 } from '#emulator/cpu/paging';

// ── Fixture helpers (mirrors paging.test.ts patterns) ──────────────────────

/** Build a pointer PTE value. */
const makePointerPte = (ppn: bigint): bigint => (1n << 0n) | (ppn << 10n) | (1n << 6n);

/** Build a leaf PTE value (V + R/W/X/U flags + A + D + PPN). */
const makeLeafPte = (ppn: bigint, x = true, u = false): bigint =>
  (1n << 0n) | (1n << 1n) | (x ? 1n << 3n : 0n) | (u ? 1n << 4n : 0n) | (1n << 6n) | (ppn << 10n);

/** Store a value into memory at a given physical address. */
const storeVal = async (
  memory: ReturnType<typeof testMemory>,
  pa: bigint,
  value: bigint
): Promise<void> => {
  await storeBytes({
    memory,
    address: unsignedBigIntToBytes(new Uint8Array(8), pa),
    source: unsignedBigIntToBytes(new Uint8Array(8), value),
    byteLength: 8,
  });
};

/**
 * Build a minimal 3-level Sv39 page table: root→L1→L0→leaf.
 * All entries share L2 index 0 and L1 index 0. Callers must
 * pass distinct L0 indices to avoid overwriting.
 */
const buildMinimalSv39PageTable = async (
  memory: ReturnType<typeof testMemory>,
  registers: ReturnType<typeof createRegisters>,
  rootPa: bigint,
  va: bigint,
  pa: bigint,
  l0IndexOverride?: number,
  x = true
): Promise<void> => {
  const l2Index = Number((va >> 30n) & 0x1ffn);
  const l1Index = Number((va >> 21n) & 0x1ffn);
  const l0Index = l0IndexOverride ?? Number((va >> 12n) & 0x1ffn);
  const l1Pa = rootPa + 0x1000n;
  const l0Pa = rootPa + 0x2000n;

  // L2 → L1
  await storeVal(memory, rootPa, makePointerPte(l1Pa >> 12n));
  // L1 → L0
  await storeVal(memory, l1Pa + BigInt(l1Index) * 8n, makePointerPte(l0Pa >> 12n));
  // L0 → leaf
  await storeVal(memory, l0Pa + BigInt(l0Index) * 8n, makeLeafPte(pa >> 12n, x));
};

/** Enable Sv39 with the given root table PA. */
const enableSv39 = (registers: ReturnType<typeof createRegisters>, rootPa: bigint): void => {
  writeControlAndStatusRegister(
    registers,
    SATP,
    unsignedBigIntToBytes(new Uint8Array(8), (BigInt(SATP_MODE_SV39) << 60n) | (rootPa >> 12n))
  );
};

// ── Bug class: Accidental regression of bare-path fetch logic when satp.MODE=Bare ──

describe('fetchInstruction (bare mode)', () => {
  it('fetches a 32-bit instruction and returns true', async () => {
    const memory = testMemory(256n);
    const registers = createRegisters();
    const pc = unsignedBigIntToBytes(new Uint8Array(8), 0n);
    setProgramCounter(registers, pc);

    // Write 32-bit instruction at PC: 0x00000093 (addi x1, x0, 0)
    await storeBytes({
      memory,
      address: pc,
      source: new Uint8Array([0x93, 0x00, 0x00, 0x00]),
      byteLength: 4,
    });

    const instructionBytes = new Uint8Array(4);
    const result = await fetchInstruction(registers, memory, instructionBytes);

    assert(result);
    assert.equal(instructionBytes[0], 0x93);
    assert.equal(instructionBytes[1], 0x00);
    assert.equal(instructionBytes[2], 0x00);
    assert.equal(instructionBytes[3], 0x00);
  });

  it('fetches a compressed instruction (2 bytes) and returns true', async () => {
    const memory = testMemory(256n);
    const registers = createRegisters();
    const pc = unsignedBigIntToBytes(new Uint8Array(8), 0n);
    setProgramCounter(registers, pc);

    // Write compressed instruction at PC: 0x0001 (c.nop)
    await storeBytes({
      memory,
      address: pc,
      source: new Uint8Array([0x01, 0x01]),
      byteLength: 2,
    });

    const instructionBytes = new Uint8Array(4);
    const result = await fetchInstruction(registers, memory, instructionBytes);

    assert(result);
    assert.equal(instructionBytes[0], 0x01);
    assert.equal(instructionBytes[1], 0x01);
  });

  it('returns false and traps on unmapped address', async () => {
    const memory = testMemory(256n);
    const registers = createRegisters();
    // PC points past the 256-byte RAM window (which ends at 0x100).
    const pc = unsignedBigIntToBytes(new Uint8Array(8), 0x200n);
    setProgramCounter(registers, pc);

    const instructionBytes = new Uint8Array(4);
    const result = await fetchInstruction(registers, memory, instructionBytes);

    assert.equal(result, false);
  });
});

// ── Bug class: Sv39 fetch fails to translate a valid mapped VA ──

describe('fetchInstructionCycle (Sv39 translation)', () => {
  it('Sv39 fetch succeeds for a mapped VA', async () => {
    const memory = testMemory(0x10000n); // 64 KB covers page table + instruction pages
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    // PMP allow all so translated fetch isn't blocked by PMP
    writeControlAndStatusRegister(
      registers,
      0x3a0, // PMPCFG0
      unsignedBigIntToBytes(new Uint8Array(8), 0x1fn)
    );
    const maskedAddr = 0xffffffffffffffffn & ((1n << 54n) - 1n);
    writeControlAndStatusRegister(
      registers,
      0x3b0,
      unsignedBigIntToBytes(new Uint8Array(8), maskedAddr)
    );

    const rootPa = 0n;
    const va = 0x1000n;
    const pa = 0x2000n;
    enableSv39(registers, rootPa);
    await buildMinimalSv39PageTable(memory, registers, rootPa, va, pa);

    // Set PC = VA = 0x1000
    setProgramCounter(registers, unsignedBigIntToBytes(new Uint8Array(8), va));

    // Write 32-bit instruction at the translated PA (0x2000)
    await storeBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), pa),
      source: new Uint8Array([0x93, 0x00, 0x00, 0x00]),
      byteLength: 4,
    });

    const instructionBytes = new Uint8Array(4);
    await fetchInstructionCycle(registers, memory, instructionBytes);

    // fetchInstructionCycle returns void — success = no trap (no continue in loop)
    // instructionBytes should have been filled from translated PA
    assert.equal(instructionBytes[0], 0x93);
    assert.equal(instructionBytes[1], 0x00);
    assert.equal(instructionBytes[2], 0x00);
    assert.equal(instructionBytes[3], 0x00);
  });

  it('Sv39 fetch traps on instruction page fault with cause 12 and xtval = VA', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    // PMP allow all
    writeControlAndStatusRegister(
      registers,
      0x3a0,
      unsignedBigIntToBytes(new Uint8Array(8), 0x1fn)
    );
    const maskedAddr = 0xffffffffffffffffn & ((1n << 54n) - 1n);
    writeControlAndStatusRegister(
      registers,
      0x3b0,
      unsignedBigIntToBytes(new Uint8Array(8), maskedAddr)
    );

    // Build page table mapping VA 0x1000 → PA 0x2000, but with a leaf that has NO X bit
    // (so fetch will page fault at cause 12)
    const rootPa = 0n;
    const va = 0x1000n;
    const pa = 0x2000n;
    enableSv39(registers, rootPa);
    // Use a leaf PTE with no execute permission
    await buildMinimalSv39PageTable(memory, registers, rootPa, va, pa, undefined, false);

    setProgramCounter(registers, unsignedBigIntToBytes(new Uint8Array(8), va));

    const instructionBytes = new Uint8Array(4);
    await fetchInstructionCycle(registers, memory, instructionBytes);

    // Trap was entered: mcause should be instruction page fault (12)
    const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
    assert.equal(mcause, CAUSE_INSTRUCTION_PAGE_FAULT);
    // mtval (0x343) should be the faulting VA
    const mtval = bytesToNumber(registers.controlAndStatus[0x343]!);
    assert.equal(mtval, Number(va));
  });

  /** Bug class: straddling 4-byte instruction across page boundary loads wrong word. */
  it('straddle: 4-byte instruction split across VA 0x1ffe/0x2000 mapped to different PAs', async () => {
    const memory = testMemory(0x20000n); // 128 KB
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      0x3a0,
      unsignedBigIntToBytes(new Uint8Array(8), 0x1fn)
    );
    const maskedAddr = 0xffffffffffffffffn & ((1n << 54n) - 1n);
    writeControlAndStatusRegister(
      registers,
      0x3b0,
      unsignedBigIntToBytes(new Uint8Array(8), maskedAddr)
    );

    const rootPa = 0n;

    // Both VAs have L2 index 0 and L1 index 0, so they share the same L2→L1 and L1→L0.
    // VA 0x1ffe: L0 index = (0x1ffe >> 12) & 0x1ff = 1
    // VA 0x2000: L0 index = (0x2000 >> 12) & 0x1ff = 2
    // Build a single page table with both leaves in the same L0 table.
    const l1Pa = rootPa + 0x1000n;
    const l0Pa = rootPa + 0x2000n;
    // L2 → L1
    await storeVal(memory, rootPa, makePointerPte(l1Pa >> 12n));
    // L1 → L0 (both share this)
    await storeVal(memory, l1Pa, makePointerPte(l0Pa >> 12n));
    // L0 leaf for VA 0x1ffe → PA 0x8000 (L0 index = 1, offset = 8)
    await storeVal(memory, l0Pa + 8n, makeLeafPte(0x8000n >> 12n, true));
    // L0 leaf for VA 0x2000 → PA 0x9000 (L0 index = 2, offset = 16)
    await storeVal(memory, l0Pa + 16n, makeLeafPte(0x9000n >> 12n, true));

    enableSv39(registers, rootPa);

    // PC = 0x1ffe (even → aligned, so misaligned check will pass)
    setProgramCounter(registers, unsignedBigIntToBytes(new Uint8Array(8), 0x1ffen));

    // The PTE maps VA page base → PA page base, and the offset is carried through.
    // For VA 0x1ffe: PA = 0x8000 | (0x1ffe & 0xfff) = 0x8000 | 0xffe = 0x8ffe (parcel 1 offset)
    // For VA 0x2000: PA = 0x9000 | (0x2000 & 0xfff) = 0x9000 | 0x000 = 0x9000 (parcel 2 offset)
    // Write instruction bytes at the two physical addresses:
    // Parcel 1 at PA 0x8ffe: bytes 0-1 of the instruction
    // Parcel 2 at PA 0x9000: bytes 2-3 of the instruction
    // Build a 32-bit instruction: low 2 bits of byte 0 must be 0x03.
    await storeBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x8ffen),
      source: new Uint8Array([0x93, 0x00]),
      byteLength: 2,
    });
    await storeBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x9000n),
      source: new Uint8Array([0x30, 0x12]),
      byteLength: 2,
    });

    const instructionBytes = new Uint8Array(4);
    await fetchInstructionCycle(registers, memory, instructionBytes);

    // Instruction bytes should reflect the assembled word from both PAs
    assert.equal(instructionBytes[0], 0x93);
    assert.equal(instructionBytes[1], 0x00);
    assert.equal(instructionBytes[2], 0x30);
    assert.equal(instructionBytes[3], 0x12);
  });

  /** Bug class: M-mode fetch under Sv39 should bypass translation (physical). */
  it('M-mode fetch under satp=Sv39 stays physical (unmapped → cause 1, not 12)', async () => {
    const memory = testMemory(256n); // small memory; 0x1000 is unmapped
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_MACHINE);

    // Enable Sv39 — but M-mode should ignore it
    enableSv39(registers, 0n);

    // PC points to an unmapped address (past the 256-byte RAM)
    setProgramCounter(registers, unsignedBigIntToBytes(new Uint8Array(8), 0x200n));

    const instructionBytes = new Uint8Array(4);
    await fetchInstructionCycle(registers, memory, instructionBytes);

    // M-mode fetch uses physical address directly → access fault (cause 1)
    // because 0x200 is unmapped (no PMP allows it in M mode by default)
    const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
    // Access fault = 1 (not page fault = 12)
    assert.equal(mcause, CAUSE_INSTRUCTION_ACCESS_FAULT);
  });

  /** Bug class: Sv39 misaligned check should happen AFTER translation succeeds. */
  it('Sv39 misaligned odd PC traps cause 0 after translation succeeds', async () => {
    const memory = testMemory(0x20000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    writeControlAndStatusRegister(
      registers,
      0x3a0,
      unsignedBigIntToBytes(new Uint8Array(8), 0x1fn)
    );
    const maskedAddr = 0xffffffffffffffffn & ((1n << 54n) - 1n);
    writeControlAndStatusRegister(
      registers,
      0x3b0,
      unsignedBigIntToBytes(new Uint8Array(8), maskedAddr)
    );

    // VA 0x1001 is an odd PC → misaligned, but the page is mapped.
    // Translation should succeed first, then misaligned trap fires.
    // VA 0x1001 → PA 0x3001 (offset 0x001)
    // VA 0x1002 → PA 0x3002 (offset 0x002)
    const rootPa = 0n;
    // Both VAs share L2 index 0, L1 index 0, L0 index 1.
    // Parcel 1: VA 0x1001 → PA 0x3000
    // Parcel 2: VA 0x1002 → PA 0x3002
    const l1Pa = rootPa + 0x1000n;
    const l0Pa = rootPa + 0x2000n;
    // L2 → L1
    await storeVal(memory, rootPa, makePointerPte(l1Pa >> 12n));
    // L1 → L0
    await storeVal(memory, l1Pa, makePointerPte(l0Pa >> 12n));
    // L0 leaf for VA 0x1001 → PA 0x3000 (L0 index = 1)
    await storeVal(memory, l0Pa + 8n, makeLeafPte(0x3000n >> 12n, true));
    // L0 leaf for VA 0x1002 → PA 0x3002 (L0 index = 1, same leaf covers the page)
    await storeVal(memory, l0Pa + 8n, makeLeafPte(0x3000n >> 12n, true));

    enableSv39(registers, rootPa);

    setProgramCounter(registers, unsignedBigIntToBytes(new Uint8Array(8), 0x1001n));

    // Write instruction bytes at PA
    await storeBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x3001n),
      source: new Uint8Array([0x93, 0x00]),
      byteLength: 2,
    });
    await storeBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x3002n),
      source: new Uint8Array([0x00, 0x00]),
      byteLength: 2,
    });

    const instructionBytes = new Uint8Array(4);
    await fetchInstructionCycle(registers, memory, instructionBytes);

    // Translation succeeded (instruction bytes filled from PA) but misaligned trap fires
    const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
    assert.equal(mcause, 0); // instruction address misaligned
  });
});
