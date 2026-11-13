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
import {
  createRegisters,
  PRIVILEGE_MACHINE,
  SATP,
  setPrivilegeMode,
  writeControlAndStatusRegister,
} from '#emulator/cpu/registers';
import {
  SATP_MODE_SV39,
  PAGE_SIZE,
  PAGE_TABLE_LEVELS,
  LEVEL_INDEX_BITS,
  PAGE_OFFSET_BITS,
  pteIsValid,
  pteIsReadable,
  pteIsWritable,
  pteIsExecutable,
  pteIsUser,
  pteIsAccessed,
  pteIsDirty,
  ptePhysicalPageNumber,
  isLevel2Aligned,
  isLevel1Aligned,
  isCanonicalVa,
  createPageFaultError,
  walkPageTable,
} from '#emulator/cpu/paging';
import { bytesToBigInt, bytesToNumber, copyBytes, unsignedBigIntToBytes } from '#utils/bytes';
import { loadBytes, storeBytes } from '#emulator/memory';
import {
  CAUSE_INSTRUCTION_ACCESS_FAULT,
  CAUSE_LOAD_ACCESS_FAULT,
  CAUSE_STORE_AMO_ACCESS_FAULT,
  CAUSE_INSTRUCTION_PAGE_FAULT,
  CAUSE_LOAD_PAGE_FAULT,
  CAUSE_STORE_AMO_PAGE_FAULT,
} from '#emulator/cpu/trap';

// ── Constants for building PTEs ───────────────────────────────────────────

const PTE_V = 1n;
const PTE_R = 2n;
const PTE_W = 4n;
const PTE_X = 8n;
const PTE_U = 16n;
const PTE_A = 64n;
const PTE_D = 128n;

/** Build a leaf PTE value for a physical page. */
const makeLeafPte = (ppn: bigint, r = true, w = false, x = false, u = false): bigint =>
  PTE_V |
  (r ? PTE_R : 0n) |
  (w ? PTE_W : 0n) |
  (x ? PTE_X : 0n) |
  (u ? PTE_U : 0n) |
  PTE_A |
  (ppn << 10n);

/** Build a level-0 leaf PTE (maps a single 4 KiB page). */
const makeLevel0Leaf = (ppn: bigint): bigint => makeLeafPte(ppn);

/** Build a level-1 leaf PTE (maps a 2 MiB superpage; PPN[0] must be 0). */
const makeLevel1Leaf = (ppn: bigint): bigint => {
  assert((ppn & 1n) === 0n, 'level-1 leaf PPN must be aligned');
  return makeLeafPte(ppn);
};

/** Build a level-2 leaf PTE (maps a 1 GiB superpage; PPN[1:0] must be 0). */
const makeLevel2Leaf = (ppn: bigint): bigint => {
  assert((ppn & 3n) === 0n, 'level-2 leaf PPN must be aligned');
  return makeLeafPte(ppn);
};

/** Build a level-N pointer PTE (points to next-level table). */
const makePointerPte = (ppn: bigint): bigint => PTE_V | (ppn << 10n) | PTE_A;

/** Store a PTE value at a physical address in memory. */
const storePte = async (
  memory: ReturnType<typeof testMemory>,
  ptePa: bigint,
  pteValue: bigint
): Promise<void> => {
  await storeBytes({
    memory,
    address: unsignedBigIntToBytes(new Uint8Array(8), ptePa),
    source: unsignedBigIntToBytes(new Uint8Array(8), pteValue),
    byteLength: 8,
  });
};

// ── Fixture builder ──────────────────────────────────────────────────────

/**
 * Build a minimal 3-level Sv39 page table rooted at RAM address 0,
 * mapping a single 4 KiB page at VA 0x1000 → PA 0x1000.
 */
const buildMinimalSv39PageTable = async (
  memory: ReturnType<typeof testMemory>,
  registers: ReturnType<typeof createRegisters>
) => {
  // Enable Sv39 translation
  const satp = unsignedBigIntToBytes(new Uint8Array(8), BigInt(SATP_MODE_SV39) << 60n);
  writeControlAndStatusRegister(registers, SATP, satp);

  // Root table at PA 0, level 1 table at PA 0x1000, level 0 table at PA 0x2000
  const rootPa = 0n;
  const level1Pa = 0x1000n;
  const level0Pa = 0x2000n;

  // VA 0x1000 → PA 0x1000 (both page-aligned, index 1 at all levels)
  const va = 0x1000n;

  // Level 2 index for VA 0x1000: (0x1000 >> (12+18)) & 0x1ff = 0
  const l2Index = Number((va >> 30n) & 0x1ffn);
  // Level 1 index: (0x1000 >> (12+9)) & 0x1ff = 0
  const l1Index = Number((va >> 21n) & 0x1ffn);
  // Level 0 index: (0x1000 >> 12) & 0x1ff = 1
  const l0Index = Number((va >> 12n) & 0x1ffn);

  // Build: root → L1 table at PA 0x1000
  const l1Ppn = level1Pa >> 12n;
  await storePte(memory, rootPa, makePointerPte(l1Ppn));

  // Build: L1 → L0 table at PA 0x2000
  const l0Ppn = level0Pa >> 12n;
  await storePte(memory, level1Pa + BigInt(l1Index) * 8n, makePointerPte(l0Ppn));

  // Build: L0 → leaf at PA 0x1000
  const leafPpn = va >> 12n;
  const leafPtePa = level0Pa + BigInt(l0Index) * 8n;
  await storePte(memory, leafPtePa, makeLevel0Leaf(leafPpn));

  return { rootPa, level1Pa, level0Pa, leafPtePa };
};

/**
 * Set up registers so Sv39 is active and the root table is at the given PA.
 */
const enableSv39 = (registers: ReturnType<typeof createRegisters>, rootPa: bigint): void => {
  const satp = unsignedBigIntToBytes(
    new Uint8Array(8),
    (BigInt(SATP_MODE_SV39) << 60n) | (rootPa >> 12n)
  );
  writeControlAndStatusRegister(registers, SATP, satp);
};

// ── Test suites ───────────────────────────────────────────────────────────

describe('paging constants', () => {
  it('exports correct Sv39 constants', () => {
    assert.equal(SATP_MODE_SV39, 8);
    assert.equal(PAGE_SIZE, 4096);
    assert.equal(PAGE_TABLE_LEVELS, 3);
    assert.equal(LEVEL_INDEX_BITS, 9);
    assert.equal(PAGE_OFFSET_BITS, 12);
  });
});

describe('pte field extraction', () => {
  const basePte = PTE_V | PTE_R | PTE_W | PTE_X | PTE_U | PTE_A | PTE_D;
  const ppn = 0x123456789n;
  const fullPte = basePte | (ppn << 10n);

  it('extracts V bit', () => {
    assert(pteIsValid(fullPte));
    assert(!pteIsValid(0n));
    assert(!pteIsValid(PTE_R)); // V=0
  });

  it('extracts R bit', () => {
    assert(pteIsReadable(fullPte));
    assert(!pteIsReadable(PTE_V));
    assert(!pteIsReadable(PTE_W));
    assert(pteIsReadable(PTE_R));
  });

  it('extracts W bit', () => {
    assert(pteIsWritable(fullPte));
    assert(!pteIsWritable(PTE_V));
    assert(!pteIsWritable(PTE_R));
    assert(pteIsWritable(PTE_W));
  });

  it('extracts X bit', () => {
    assert(pteIsExecutable(fullPte));
    assert(!pteIsExecutable(PTE_V));
    assert(!pteIsExecutable(PTE_R | PTE_W));
    assert(pteIsExecutable(PTE_X));
  });

  it('extracts U bit', () => {
    assert(pteIsUser(fullPte));
    assert(!pteIsUser(PTE_V));
    assert(!pteIsUser(PTE_R | PTE_W));
    assert(pteIsUser(PTE_U));
  });

  it('extracts A bit', () => {
    assert(pteIsAccessed(fullPte));
    assert(!pteIsAccessed(PTE_V));
    assert(!pteIsAccessed(PTE_R | PTE_W | PTE_X));
    assert(pteIsAccessed(PTE_A));
  });

  it('extracts D bit', () => {
    assert(pteIsDirty(fullPte));
    assert(!pteIsDirty(PTE_V));
    assert(!pteIsDirty(PTE_A));
    assert(pteIsDirty(PTE_D));
  });

  it('extracts PPN correctly', () => {
    assert.equal(ptePhysicalPageNumber(fullPte), ppn);
    assert.equal(ptePhysicalPageNumber(0n), 0n);
    // PTE with only V bit set: PPN = 0
    assert.equal(ptePhysicalPageNumber(PTE_V), 0n);
  });
});

describe('superpage alignment checks', () => {
  it('isLevel2Aligned passes when PPN[1:0] == 0, fails when nonzero', () => {
    // PPN=0 → aligned
    assert(isLevel2Aligned(makeLevel2Leaf(0n)));
    // PPN=4 → aligned (binary 100, [1:0]=00)
    assert(isLevel2Aligned(makeLeafPte(4n)));
    // PPN=1 → not aligned (binary 01, [1:0]=01)
    assert(!isLevel2Aligned(makeLeafPte(1n)));
    // PPN=2 → not aligned (binary 10, [1:0]=10)
    assert(!isLevel2Aligned(makeLeafPte(2n)));
    // PPN=3 → not aligned (binary 11, [1:0]=11)
    assert(!isLevel2Aligned(makeLeafPte(3n)));
  });

  it('isLevel1Aligned passes when PPN[0] == 0, fails when nonzero', () => {
    // PPN=0 → aligned
    assert(isLevel1Aligned(makeLevel1Leaf(0n)));
    // PPN=2 → aligned (binary 10, [0]=0)
    assert(isLevel1Aligned(makeLeafPte(2n)));
    // PPN=1 → not aligned (binary 01, [0]=1)
    assert(!isLevel1Aligned(makeLeafPte(1n)));
    // PPN=3 → not aligned (binary 11, [0]=1)
    assert(!isLevel1Aligned(makeLeafPte(3n)));
  });
});

describe('canonical VA check', () => {
  it('accepts canonical positive VA (upper bits = 0, bit47 = 0)', () => {
    const va = 0x0000_1000_0000n; // bit47=0, bits 63:48=0
    assert(isCanonicalVa(va));
  });

  it('accepts canonical negative VA (upper bits = all 1s, bit47 = 1)', () => {
    const va = 0xffff_ffff_ffff_f000n; // bit47=1, upper bits all 1s
    assert(isCanonicalVa(va));
  });

  it('accepts VA 0 (fully canonical)', () => {
    assert(isCanonicalVa(0n));
  });

  it('rejects non-canonical VA: bit47=0 but upper bits nonzero', () => {
    const va = 0x1000_0000_0000_0000n; // bit47=0, bit60=1
    assert(!isCanonicalVa(va));
  });

  it('rejects non-canonical VA: bit47=1 but upper bits not all 1s', () => {
    const va = 0x8000_0000_0000_f000n; // bit47=1, bit63=0 (not all 1s)
    assert(!isCanonicalVa(va));
  });
});

// Helper to assert that an async walk throws a page-fault error with a given cause
const assertPageFaultError = async (
  fn: () => Promise<unknown>,
  expectedCause: number
): Promise<void> => {
  try {
    await fn();
    assert.fail('expected page fault error');
  } catch (error) {
    assert(error instanceof Error, `expected Error, got ${error}`);
    assert.equal((error as Error & { cause: number }).cause, expectedCause);
  }
};

describe('walk page table — canonical VA', () => {
  it('accepts a canonical positive VA when a valid leaf is found', async () => {
    const memory = testMemory(0x10000n); // 64 KB RAM
    const registers = createRegisters();

    await buildMinimalSv39PageTable(memory, registers);

    // VA 0x1000 is canonical (positive)
    const result = await walkPageTable(
      registers,
      memory,
      unsignedBigIntToBytes(new Uint8Array(8), 0x1000n),
      'fetch'
    );

    assert(result.success);
    assert.equal(result.level, 0);
  });

  it('rejects a non-canonical VA with a page fault', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    await buildMinimalSv39PageTable(memory, registers);

    // VA 0x1_0000_0000 is non-canonical (bit47=0, but bit48=1)
    await assertPageFaultError(
      () =>
        walkPageTable(
          registers,
          memory,
          unsignedBigIntToBytes(new Uint8Array(8), 0x1_0000_0000n),
          'fetch'
        ),
      CAUSE_INSTRUCTION_PAGE_FAULT
    );
  });
});

describe('walk page table — valid bit checks', () => {
  it('raises page fault when level-2 PTE has V=0', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    // Root table at PA 0, entry 0 = 0 (V=0)
    writeControlAndStatusRegister(registers, SATP, unsignedBigIntToBytes(new Uint8Array(8), 0n));

    // VA 0x0 (first 1 GiB window), entry[0] = 0x0
    await assertPageFaultError(
      () => walkPageTable(registers, memory, unsignedBigIntToBytes(new Uint8Array(8), 0n), 'fetch'),
      CAUSE_INSTRUCTION_PAGE_FAULT
    );
  });

  it('raises page fault when level-1 PTE has V=0', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    // Root → L1 at PA 0x1000 (L1 entry 0 has V=0)
    enableSv39(registers, 0n);
    await storePte(memory, 0n, makePointerPte(0x100n)); // L1 at PA 0x1000

    // L0 table at PA 0x2000 with a leaf (won't be reached)
    await storePte(memory, 0x2000n, makeLevel0Leaf(0x200n));

    // VA with l2Index=0, l1Index=0 → root[0] → L1[0]=0x0
    await assertPageFaultError(
      () => walkPageTable(registers, memory, unsignedBigIntToBytes(new Uint8Array(8), 0n), 'fetch'),
      CAUSE_INSTRUCTION_PAGE_FAULT
    );
  });

  it('raises page fault when level-0 PTE has V=0', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    // Full 3-level hierarchy, L0 entry 0 has V=0
    enableSv39(registers, 0n);
    await storePte(memory, 0n, makePointerPte(0x100n));
    await storePte(memory, 0x1000n, makePointerPte(0x200n));

    // L0 entry 0 = 0 (V=0)
    await storePte(memory, 0x2000n, 0n);

    await assertPageFaultError(
      () => walkPageTable(registers, memory, unsignedBigIntToBytes(new Uint8Array(8), 0n), 'fetch'),
      CAUSE_INSTRUCTION_PAGE_FAULT
    );
  });
});

describe('walk page table — R=0, W=1 invalid combination', () => {
  it('raises page fault for a PTE with R=0 and W=1 (leaf)', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    // Build 3-level table, but L0 PTE has W=1, R=0
    enableSv39(registers, 0n);
    await storePte(memory, 0n, makePointerPte(0x100n));
    await storePte(memory, 0x1000n, makePointerPte(0x200n));
    const badPte = PTE_V | PTE_W | PTE_A; // V=1, W=1, R=0, X=0 → invalid
    await storePte(memory, 0x2000n, badPte);

    await assertPageFaultError(
      () => walkPageTable(registers, memory, unsignedBigIntToBytes(new Uint8Array(8), 0n), 'fetch'),
      CAUSE_INSTRUCTION_PAGE_FAULT
    );
  });
});

describe('walk page table — pointer at level 0', () => {
  it('raises page fault when level-0 PTE is a pointer (R=0, X=0) instead of a leaf', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    enableSv39(registers, 0n);
    await storePte(memory, 0n, makePointerPte(0x100n));
    await storePte(memory, 0x1000n, makePointerPte(0x200n));

    // L0 entry 0 = V=1, A=1, but R=0 and X=0 → pointer, not leaf
    await storePte(memory, 0x2000n, PTE_V | PTE_A);

    await assertPageFaultError(
      () => walkPageTable(registers, memory, unsignedBigIntToBytes(new Uint8Array(8), 0n), 'fetch'),
      CAUSE_INSTRUCTION_PAGE_FAULT
    );
  });
});

describe('walk page table — access fault on PMP denial', () => {
  it('raises instruction access fault when PMP denies a level-2 PTE read', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    // Set M-mode privilege
    setPrivilegeMode(registers, PRIVILEGE_MACHINE);

    // PMP cfg: NA4 (no permissions) at entry 0 covering PA 0
    writeControlAndStatusRegister(
      registers,
      0x3a0, // PMPCFG0
      unsignedBigIntToBytes(new Uint8Array(8), 0x10n) // entry 0 = NA4, no perms
    );
    writeControlAndStatusRegister(
      registers,
      0x3b0, // PMPADDR0
      unsignedBigIntToBytes(new Uint8Array(8), 0n)
    );

    // Root table at PA 0 → entry is denied by PMP
    enableSv39(registers, 0n);

    try {
      await walkPageTable(
        registers,
        memory,
        unsignedBigIntToBytes(new Uint8Array(8), 0x1000n),
        'fetch'
      );
      assert.fail('expected trap');
    } catch {
      // enterTrap was called — check that MCAUSE is the instruction access fault
      const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
      assert.equal(mcause, CAUSE_INSTRUCTION_ACCESS_FAULT);
      // mtval should be the VA copy
      const mtval = bytesToBigInt(registers.controlAndStatus[0x343]!);
      assert.equal(mtval, 0x1000n);
    }
  });
});

describe('walk page table — access fault on unmapped PTE PA', () => {
  it('raises load access fault when PTE PA is unmapped', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    enableSv39(registers, 0n);

    // Root entry points to PA 0x8000_0000 (outside RAM, unmapped)
    const unmappedPpn = 0x8000_0000n >> 12n;
    await storePte(memory, 0n, makePointerPte(unmappedPpn));

    try {
      await walkPageTable(
        registers,
        memory,
        unsignedBigIntToBytes(new Uint8Array(8), 0x1000n),
        'load'
      );
      assert.fail('expected trap');
    } catch {
      const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
      assert.equal(mcause, CAUSE_LOAD_ACCESS_FAULT);
      const mtval = bytesToBigInt(registers.controlAndStatus[0x343]!);
      assert.equal(mtval, 0x1000n);
    }
  });
});

describe('walk page table — successful 4 KiB leaf', () => {
  it('returns level-0 leaf for a 4 KiB mapping', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    await buildMinimalSv39PageTable(memory, registers);

    const result = await walkPageTable(
      registers,
      memory,
      unsignedBigIntToBytes(new Uint8Array(8), 0x1000n),
      'fetch'
    );

    assert(result.success);
    assert.equal(result.level, 0);
    assert(pteIsValid(result.leafPteValue));
    assert(pteIsReadable(result.leafPteValue));
  });
});

describe('walk page table — superpages', () => {
  it('returns level-2 leaf for a 1 GiB mapping', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    // Root table at PA 0, root[0] is a level-2 leaf mapping 1 GiB
    enableSv39(registers, 0n);

    // VA 0 → root entry 0 is a level-2 leaf at PA 0
    // PPN for 1 GiB superpage at PA 0 is 0, PPN[1:0]=0 → aligned
    const superpagePpn = 0n;
    await storePte(memory, 0n, makeLevel2Leaf(superpagePpn));

    const result = await walkPageTable(
      registers,
      memory,
      unsignedBigIntToBytes(new Uint8Array(8), 0n),
      'fetch'
    );

    assert(result.success);
    assert.equal(result.level, 2);
    assert(pteIsValid(result.leafPteValue));
  });
});
