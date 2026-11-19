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
  PRIVILEGE_SUPERVISOR,
  PRIVILEGE_USER,
  SATP,
  MSTATUS,
  MENVCFG,
  setPrivilegeMode,
  writeControlAndStatusRegister,
  setProgramCounter,
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
  constructPhysicalAddress,
  prepareLoadAccess,
  prepareStoreAccess,
  prepareAtomicAccess,
  prepareFetchParcel,
  fetchTranslatedInstruction,
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
  CAUSE_LOAD_ADDRESS_MISALIGNED,
  CAUSE_STORE_AMO_ADDRESS_MISALIGNED,
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

/**
 * Configure PMP to allow all accesses (NAPOT covering all memory, RWX, unlocked).
 * This is needed for S-mode/U-mode tests where no PMP restrictions are desired.
 */
const setupPmpAllowAll = (registers: ReturnType<typeof createRegisters>): void => {
  // Config byte: R=1(0x01), W=1(0x02), X=1(0x04), A=NAPOT(0x18), L=0 = 0x1F
  const rwxNapotCfg = 0x1fn;
  writeControlAndStatusRegister(
    registers,
    0x3a0, // PMPCFG0
    unsignedBigIntToBytes(new Uint8Array(8), rwxNapotCfg)
  );
  // PMPADDR0: NAPOT requires the value after masking to have trailing ones.
  // (1<<54)-1 = 0x3ffffffffffff, >> 2 = 0xfffffffffffff (52 trailing ones)
  // Range: [0, 2^55) which covers all practical test memory.
  const maskedAddr = 0xffffffffffffffffn & ((1n << 54n) - 1n);
  writeControlAndStatusRegister(
    registers,
    0x3b0, // PMPADDR0
    unsignedBigIntToBytes(new Uint8Array(8), maskedAddr)
  );
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
      'load'
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
          'load'
        ),
      CAUSE_LOAD_PAGE_FAULT
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
      () => walkPageTable(registers, memory, unsignedBigIntToBytes(new Uint8Array(8), 0n), 'load'),
      CAUSE_LOAD_PAGE_FAULT
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
      () => walkPageTable(registers, memory, unsignedBigIntToBytes(new Uint8Array(8), 0n), 'load'),
      CAUSE_LOAD_PAGE_FAULT
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
      () => walkPageTable(registers, memory, unsignedBigIntToBytes(new Uint8Array(8), 0n), 'load'),
      CAUSE_LOAD_PAGE_FAULT
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
      () => walkPageTable(registers, memory, unsignedBigIntToBytes(new Uint8Array(8), 0n), 'load'),
      CAUSE_LOAD_PAGE_FAULT
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
      () => walkPageTable(registers, memory, unsignedBigIntToBytes(new Uint8Array(8), 0n), 'load'),
      CAUSE_LOAD_PAGE_FAULT
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
      'load'
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
      'load'
    );

    assert(result.success);
    assert.equal(result.level, 2);
    assert(pteIsValid(result.leafPteValue));
  });
});

// ── B2: Leaf Permission & A/D Bit Tests ────────────────────────────────────

/** Helper: build a minimal Sv39 page table and return leaf PA.
 * Maps VA 0x2_000_000 (l2Idx=0, l1Idx=16, l0Idx=0) to leaf at PA 0x2000. */
const buildSv39LeafAtPa0x2000 = async (
  memory: ReturnType<typeof testMemory>,
  registers: ReturnType<typeof createRegisters>,
  leafPte: bigint
): Promise<void> => {
  enableSv39(registers, 0n);
  // Root[0] → L1 at PA 0x1000 (PPN 0x1)
  await storePte(memory, 0n, makePointerPte(0x1n));
  // L1[16] → L0 table at PA 0x2000 (0x1000 + 16*8 = 0x1080)
  await storePte(memory, 0x1080n, makePointerPte(0x2n));
  // L0[0] leaf at PA 0x2000
  await storePte(memory, 0x2000n, leafPte);
};

/** Helper: build L2 leaf at root table (PA 0) for superpage alignment tests. */
const buildSv39Level2Leaf = async (
  memory: ReturnType<typeof testMemory>,
  registers: ReturnType<typeof createRegisters>,
  leafPte: bigint
): Promise<void> => {
  // For L2 leaf, the root table entry ITSELF is the leaf.
  enableSv39(registers, 0n);
  await storePte(memory, 0n, leafPte);
};

/** Helper: build 3-level tree with L1 leaf at specific PA for superpage tests. */
const buildSv39L1Leaf = async (
  memory: ReturnType<typeof testMemory>,
  registers: ReturnType<typeof createRegisters>,
  l1LeafPte: bigint,
  l1LeafPa: bigint
): Promise<void> => {
  enableSv39(registers, 0n);
  // Root → L1 at PA 0x1000
  await storePte(memory, 0n, makePointerPte(0x100n));
  // L1 table at PA 0x2000
  await storePte(memory, 0x1000n, makePointerPte(0x200n));
  // L1 leaf at specified PA
  await storePte(memory, l1LeafPa, l1LeafPte);
};

describe('walk page table — U-bit & privilege checks', () => {
  it('U-mode can access U=1 pages', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_USER);
    setupPmpAllowAll(registers);

    const leafPte = PTE_V | PTE_R | PTE_A | PTE_U;
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    const result = await walkPageTable(
      registers,
      memory,
      unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
      'load'
    );
    assert(result.success);
  });

  it('S-mode cannot access U=1 pages without SUM (load)', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);

    const leafPte = PTE_V | PTE_R | PTE_U;
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    await assertPageFaultError(
      () =>
        walkPageTable(
          registers,
          memory,
          unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
          'load'
        ),
      CAUSE_LOAD_PAGE_FAULT
    );
  });

  it('S-mode can access U=1 pages with SUM (load)', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);

    // Set SUM in mstatus (bit 18 → byte 2, bit 2)
    const mstatus = new Uint8Array([0, 0, 0x04, 0, 0, 0, 0, 0]);
    writeControlAndStatusRegister(registers, MSTATUS, mstatus);

    const leafPte = PTE_V | PTE_R | PTE_A | PTE_U;
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    const result = await walkPageTable(
      registers,
      memory,
      unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
      'load'
    );
    assert(result.success);
  });

  it('S-mode fetch is never SUM-gated (fails on U=1 page)', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);

    // Set SUM in mstatus
    const mstatus = new Uint8Array([0, 0, 0x04, 0, 0, 0, 0, 0]);
    writeControlAndStatusRegister(registers, MSTATUS, mstatus);

    const leafPte = PTE_V | PTE_X | PTE_U;
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    await assertPageFaultError(
      () =>
        walkPageTable(
          registers,
          memory,
          unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
          'fetch'
        ),
      CAUSE_INSTRUCTION_PAGE_FAULT
    );
  });
});

describe('walk page table — MXR checks', () => {
  it('S-mode load fails on X-only page without MXR', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);

    const leafPte = PTE_V | PTE_X;
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    await assertPageFaultError(
      () =>
        walkPageTable(
          registers,
          memory,
          unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
          'load'
        ),
      CAUSE_LOAD_PAGE_FAULT
    );
  });

  it('S-mode load succeeds on X-only page with MXR', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);

    // Set MXR in mstatus (bit 19 → byte 2, bit 3)
    const mstatus = new Uint8Array([0, 0, 0x08, 0, 0, 0, 0, 0]);
    writeControlAndStatusRegister(registers, MSTATUS, mstatus);

    const leafPte = PTE_V | PTE_X | PTE_A;
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    const result = await walkPageTable(
      registers,
      memory,
      unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
      'load'
    );
    assert(result.success);
  });

  it('Store fails on X-only page even with MXR', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);

    const mstatus = new Uint8Array([0, 0, 0x08, 0, 0, 0, 0, 0]);
    writeControlAndStatusRegister(registers, MSTATUS, mstatus);

    const leafPte = PTE_V | PTE_X;
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    await assertPageFaultError(
      () =>
        walkPageTable(
          registers,
          memory,
          unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
          'store'
        ),
      CAUSE_STORE_AMO_PAGE_FAULT
    );
  });
});

describe('walk page table — AMO permission checks', () => {
  it('AMO fails on R=1, W=0 PTE', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    const leafPte = PTE_V | PTE_R | PTE_A;
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    await assertPageFaultError(
      () =>
        walkPageTable(
          registers,
          memory,
          unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
          'amo'
        ),
      CAUSE_STORE_AMO_PAGE_FAULT
    );
  });

  it('AMO fails on R=0, W=1 PTE', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    const leafPte = PTE_V | PTE_W | PTE_A;
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    await assertPageFaultError(
      () =>
        walkPageTable(
          registers,
          memory,
          unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
          'amo'
        ),
      CAUSE_STORE_AMO_PAGE_FAULT
    );
  });

  it('AMO succeeds on R=1, W=1 PTE', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    const leafPte = PTE_V | PTE_R | PTE_W | PTE_A | PTE_D;
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    const result = await walkPageTable(
      registers,
      memory,
      unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
      'amo'
    );
    assert(result.success);
  });
});

describe('walk page table — A/D bit updates', () => {
  it('A bit is set on load when ADUE is enabled', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    // Enable ADUE (menvcfg byte7 bit 5 = 0x20)
    const menvcfg = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0x20]);
    writeControlAndStatusRegister(registers, MENVCFG, menvcfg);

    const leafPte = PTE_V | PTE_R | PTE_A; // A is already set
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    const result = await walkPageTable(
      registers,
      memory,
      unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
      'load'
    );
    assert(result.success);

    // Check that PTE at 0x2000 was updated (A bit should remain set, no change needed)
    const buf = new Uint8Array(8);
    await loadBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x2000n),
      destination: buf,
      byteLength: 8,
    });
    const updatedPte = bytesToBigInt(buf);
    assert(pteIsAccessed(updatedPte));
  });

  it('A and D bits are set on store when ADUE is enabled', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    // Enable ADUE
    const menvcfg = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0x20]);
    writeControlAndStatusRegister(registers, MENVCFG, menvcfg);

    // PTE with A=0, D=0
    const leafPte = PTE_V | PTE_R | PTE_W;
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    await walkPageTable(
      registers,
      memory,
      unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
      'store'
    );

    // Check PTE was updated
    const buf = new Uint8Array(8);
    await loadBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x2000n),
      destination: buf,
      byteLength: 8,
    });
    const updatedPte = bytesToBigInt(buf);
    assert(pteIsAccessed(updatedPte));
    assert(pteIsDirty(updatedPte));
  });

  it('Load fails when A=0 and ADUE is disabled', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    // ADUE disabled (default 0)
    const leafPte = PTE_V | PTE_R; // A=0
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    await assertPageFaultError(
      () =>
        walkPageTable(
          registers,
          memory,
          unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
          'load'
        ),
      CAUSE_LOAD_PAGE_FAULT
    );
  });

  it('Store fails when D=0 and ADUE is disabled', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    // ADUE disabled
    const leafPte = PTE_V | PTE_R | PTE_W; // A=0, D=0
    await buildSv39LeafAtPa0x2000(memory, registers, leafPte);

    await assertPageFaultError(
      () =>
        walkPageTable(
          registers,
          memory,
          unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
          'store'
        ),
      CAUSE_STORE_AMO_PAGE_FAULT
    );
  });
});

describe('walk page table — superpage alignment failures', () => {
  it('L2 superpage with unaligned PPN causes page fault', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    // L2 leaf with PPN=1 (unaligned)
    const unalignedLeafPte = PTE_V | PTE_R | (1n << 10n);
    await buildSv39Level2Leaf(memory, registers, unalignedLeafPte);

    await assertPageFaultError(
      () =>
        walkPageTable(
          registers,
          memory,
          unsignedBigIntToBytes(new Uint8Array(8), 0x2_000_000n),
          'load'
        ),
      CAUSE_LOAD_PAGE_FAULT
    );
  });

  it('L1 superpage with unaligned PPN causes page fault', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();

    // L1 superpage: L2 entry[0] is the leaf at PA 0x3000 with unaligned PPN (PPN=1)
    // PPN=1 → PA = 0x1000, PPN[0]=1 means unaligned for 2 MiB superpage
    const unalignedLeafPte = PTE_V | PTE_R | PTE_A | (1n << 10n);
    await storePte(memory, 0n, unalignedLeafPte);

    // VA 0x200000 maps to L2 index 0, L1 index 1
    const va = 0x200000n; // l2Idx=0, l1Idx=1
    await assertPageFaultError(
      () => walkPageTable(registers, memory, unsignedBigIntToBytes(new Uint8Array(8), va), 'load'),
      CAUSE_LOAD_PAGE_FAULT
    );
  });
});

// ── B3: Gate Helpers & Fetch Tests ────────────────────────────────────────

describe('constructPhysicalAddress', () => {
  it('constructs correct PA for level-0 leaf (4 KiB)', () => {
    // VA = 0x1234_dead_ef, PPN = 0x5678 → PA = (0x5678 << 12) | (VA & 0xfff)
    // = 0x5678000 | 0xdef = 0x5678def
    const va = 0x1234deadefn;
    const pteValue = PTE_V | PTE_R | PTE_A | PTE_D | (0x5678n << 10n);
    const pa = constructPhysicalAddress(pteValue, va, 0);
    const expectedPa = unsignedBigIntToBytes(new Uint8Array(8), 0x5678defn);
    assert.deepEqual(pa, expectedPa);
  });

  it('constructs correct PA for level-1 leaf (2 MiB)', () => {
    // VA = 0x200_0000, PPN = 0x12 → PA = (0x12 << 12) | (VA & 0x1fffff)
    // = 0x12000 | 0 = 0x12000
    const va = 0x2000000n;
    const pteValue = PTE_V | PTE_R | PTE_A | PTE_D | (0x12n << 10n);
    const pa = constructPhysicalAddress(pteValue, va, 1);
    const expectedPa = unsignedBigIntToBytes(new Uint8Array(8), 0x12000n);
    assert.deepEqual(pa, expectedPa);
  });

  it('constructs correct PA for level-2 leaf (1 GiB)', () => {
    // VA = 0x0, PPN = 0x1 → PA = (0x1 << 12) | 0 = 0x1000
    const va = 0n;
    const pteValue = PTE_V | PTE_R | PTE_A | PTE_D | (0x1n << 10n);
    const pa = constructPhysicalAddress(pteValue, va, 2);
    const expectedPa = unsignedBigIntToBytes(new Uint8Array(8), 0x1000n);
    assert.deepEqual(pa, expectedPa);
  });
});

describe('prepareLoadAccess — bare mode parity', () => {
  it('returns VA as PA in bare mode', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    // Ensure Sv39 is NOT active (bare mode)
    const satp = unsignedBigIntToBytes(new Uint8Array(8), 0n); // MODE=Bare
    writeControlAndStatusRegister(registers, SATP, satp);

    const result = await prepareLoadAccess({
      registers,
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0xdeadbeefn),
      byteLength: 8,
    });

    assert(!result.denied);
    const pa = bytesToBigInt(result.physicalAddress);
    assert.equal(pa, 0xdeadbeefn);
  });
});

describe('prepareStoreAccess — bare mode parity', () => {
  it('returns VA as PA in bare mode', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    const satp = unsignedBigIntToBytes(new Uint8Array(8), 0n);
    writeControlAndStatusRegister(registers, SATP, satp);

    const result = await prepareStoreAccess({
      registers,
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0xcafebaben),
      byteLength: 8,
    });

    assert(!result.denied);
    const pa = bytesToBigInt(result.physicalAddress);
    assert.equal(pa, 0xcafebaben);
  });
});

describe('prepareAtomicAccess — alignment checks', () => {
  it('raises address-misaligned fault for LR on unaligned address', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    const satp = unsignedBigIntToBytes(new Uint8Array(8), 0n); // bare mode
    writeControlAndStatusRegister(registers, SATP, satp);

    try {
      await prepareAtomicAccess({
        registers,
        memory,
        address: unsignedBigIntToBytes(new Uint8Array(8), 0x1001n), // unaligned
        byteLength: 4,
        atomicAccess: 'lr',
      });
      assert.fail('expected misaligned fault');
    } catch (error) {
      assert(error instanceof Error);
      const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
      assert.equal(mcause, CAUSE_LOAD_ADDRESS_MISALIGNED);
    }
  });

  it('raises address-misaligned fault for SC on unaligned address', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    const satp = unsignedBigIntToBytes(new Uint8Array(8), 0n);
    writeControlAndStatusRegister(registers, SATP, satp);

    try {
      await prepareAtomicAccess({
        registers,
        memory,
        address: unsignedBigIntToBytes(new Uint8Array(8), 0x1001n),
        byteLength: 4,
        atomicAccess: 'sc',
      });
      assert.fail('expected misaligned fault');
    } catch (error) {
      assert(error instanceof Error);
      const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
      assert.equal(mcause, CAUSE_STORE_AMO_ADDRESS_MISALIGNED);
    }
  });

  it('raises address-misaligned fault for AMO on unaligned address', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    const satp = unsignedBigIntToBytes(new Uint8Array(8), 0n);
    writeControlAndStatusRegister(registers, SATP, satp);

    try {
      await prepareAtomicAccess({
        registers,
        memory,
        address: unsignedBigIntToBytes(new Uint8Array(8), 0x1001n),
        byteLength: 8,
        atomicAccess: 'amo',
      });
      assert.fail('expected misaligned fault');
    } catch (error) {
      assert(error instanceof Error);
      const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
      assert.equal(mcause, CAUSE_STORE_AMO_ADDRESS_MISALIGNED);
    }
  });

  it('succeeds for aligned LR in bare mode', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    const satp = unsignedBigIntToBytes(new Uint8Array(8), 0n);
    writeControlAndStatusRegister(registers, SATP, satp);

    const result = await prepareAtomicAccess({
      registers,
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x1000n),
      byteLength: 4,
      atomicAccess: 'lr',
    });

    assert(!result.denied);
  });
});

describe('prepareFetchParcel — fetch rules', () => {
  it('returns VA as PA in bare mode', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    const satp = unsignedBigIntToBytes(new Uint8Array(8), 0n);
    writeControlAndStatusRegister(registers, SATP, satp);

    const pc = unsignedBigIntToBytes(new Uint8Array(8), 0x1000n);
    const result = await prepareFetchParcel({ registers, memory, address: pc, trapValue: pc });

    assert(!result.denied);
    const pa = bytesToBigInt(result.physicalAddress);
    assert.equal(pa, 0x1000n);
  });

  it('M-mode fetch is physical even under Sv39', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_MACHINE);
    setupPmpAllowAll(registers);

    // Enable Sv39
    enableSv39(registers, 0n);

    const pc = unsignedBigIntToBytes(new Uint8Array(8), 0x1000n);
    const result = await prepareFetchParcel({ registers, memory, address: pc, trapValue: pc });

    assert(!result.denied);
    const pa = bytesToBigInt(result.physicalAddress);
    assert.equal(pa, 0x1000n); // Physical, not translated
  });
});

describe('fetchTranslatedInstruction — straddle and compressed', () => {
  it('successfully fetches a compressed instruction (2 bytes)', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    const satp = unsignedBigIntToBytes(new Uint8Array(8), 0n); // bare mode
    writeControlAndStatusRegister(registers, SATP, satp);

    // Set PC to 0x1000
    const pcBytes = unsignedBigIntToBytes(new Uint8Array(8), 0x1000n);
    setProgramCounter(registers, pcBytes);

    // Compressed instruction: 0x0001 (c.nop)
    const instrBytes = new Uint8Array(8);
    await storeBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x1000n),
      source: new Uint8Array([0x01, 0x01]), // c.nop
      byteLength: 2,
    });

    const result = await fetchTranslatedInstruction({
      registers,
      memory,
      instructionBytes: instrBytes,
    });

    assert(result);
    assert.equal(instrBytes[0], 0x01);
    assert.equal(instrBytes[1], 0x01);
  });

  it('successfully fetches a 32-bit instruction spanning two parcels', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    const satp = unsignedBigIntToBytes(new Uint8Array(8), 0n);
    writeControlAndStatusRegister(registers, SATP, satp);

    const pcBytes = unsignedBigIntToBytes(new Uint8Array(8), 0x1000n);
    setProgramCounter(registers, pcBytes);

    // 32-bit instruction: 0x00000093 (addi x1, x0, 0)
    // Split across two 2-byte parcels
    await storeBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x1000n),
      source: new Uint8Array([0x93, 0x00]),
      byteLength: 2,
    });
    await storeBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x1002n),
      source: new Uint8Array([0x00, 0x00]),
      byteLength: 2,
    });

    const instrBytes = new Uint8Array(8);
    const result = await fetchTranslatedInstruction({
      registers,
      memory,
      instructionBytes: instrBytes,
    });

    assert(result);
    assert.equal(instrBytes[0], 0x93);
    assert.equal(instrBytes[1], 0x00);
    assert.equal(instrBytes[2], 0x00);
    assert.equal(instrBytes[3], 0x00);
  });

  it('fetches a 32-bit instruction across translated parcels (Sv39)', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setupPmpAllowAll(registers);

    const va = 0x801000n;
    const codePa = 0x3000n;
    const codePpn = codePa >> 12n;

    // Encode addi x1, x0, 0x123 without handwriting raw bytes.
    const instruction = Number((0x123n << 20n) | (1n << 7n) | 0x13n);
    const source = new Uint8Array([
      instruction & 0xff,
      (instruction >>> 8) & 0xff,
      (instruction >>> 16) & 0xff,
      (instruction >>> 24) & 0xff,
    ]);
    await storeBytes({
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), codePa),
      source,
      byteLength: source.byteLength,
    });

    // Build a minimal Sv39 mapping: root at PA 0, L1 at PA 0x1000,
    // L0 at PA 0x2000, mapping VA 0x801000 -> code PA 0x3000 (executable).
    const l2Index = Number((va >> 30n) & 0x1ffn);
    const l1Index = Number((va >> 21n) & 0x1ffn);
    const l0Index = Number((va >> 12n) & 0x1ffn);
    await storePte(memory, 0n + BigInt(l2Index) * 8n, makePointerPte(0x1000n >> 12n));
    await storePte(memory, 0x1000n + BigInt(l1Index) * 8n, makePointerPte(0x2000n >> 12n));
    await storePte(memory, 0x2000n + BigInt(l0Index) * 8n, makeLeafPte(codePpn, true, false, true));
    enableSv39(registers, 0n);

    const pcBytes = unsignedBigIntToBytes(new Uint8Array(8), va);
    setProgramCounter(registers, pcBytes);
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);

    const instrBytes = new Uint8Array(8);
    const result = await fetchTranslatedInstruction({
      registers,
      memory,
      instructionBytes: instrBytes,
    });

    assert(result);
    assert.deepEqual(instrBytes.subarray(0, 4), source);
  });

  describe('MPRV data path behavior', () => {
    it('M-mode load with satp=Sv39 and MPRV=0: bypasses translation (physical access)', async () => {
      const memory = testMemory(0x10000n);
      const registers = createRegisters();
      const va = 0x8000_8000n; // Virtual address that will NOT have page table mapping

      // Enable Sv39 with root at PA 0x1000 (page table will be EMPTY)
      enableSv39(registers, 0x1000n);

      // Set M-mode with MPRV=0 (default)
      setPrivilegeMode(registers, PRIVILEGE_MACHINE);
      const mstatus = new Uint8Array(8);
      mstatus[0] = 0x00; // SPIE=0, SIE=0
      mstatus[1] = 0x00; // SPP=U
      mstatus[2] = 0x00; // MPRV=0, MXR=0, SUM=0
      writeControlAndStatusRegister(registers, MSTATUS, mstatus);

      // Load from virtual address 0x8000_8000 - this should be treated as physical 0x8000_8000
      // With MPRV=0 in M-mode, translation should be bypassed
      // So VA 0x8000_8000 should be treated as PA 0x8000_8000, not walk the page table
      const vaBytes = unsignedBigIntToBytes(new Uint8Array(8), va);
      const loadResult = await prepareLoadAccess({
        registers,
        memory,
        address: vaBytes,
        byteLength: 8,
      });

      // The bug is: if the code incorrectly walks the page table, it will fault
      // because there's no mapping for VA 0x8000_8000
      // The correct behavior: M-mode with MPRV=0 should bypass translation and use VA as PA
      assert(!loadResult.denied, 'M-mode load with MPRV=0 should succeed (physical access)');
      assert.deepEqual(loadResult.physicalAddress, vaBytes, 'PA should equal VA');
    });

    it('M-mode store with satp=Sv39 and MPRV=0: bypasses translation (physical access)', async () => {
      const memory = testMemory(0x10000n);
      const registers = createRegisters();
      const va = 0x8000_9000n; // Virtual address that will NOT have page table mapping

      // Enable Sv39 with root at PA 0x1000 (page table will be EMPTY)
      enableSv39(registers, 0x1000n);

      // Set M-mode with MPRV=0 (default)
      setPrivilegeMode(registers, PRIVILEGE_MACHINE);
      const mstatus = new Uint8Array(8);
      mstatus[0] = 0x00;
      mstatus[1] = 0x00;
      mstatus[2] = 0x00; // MPRV=0
      writeControlAndStatusRegister(registers, MSTATUS, mstatus);

      // Store to address should succeed despite satp being active
      // M-mode with MPRV=0 should bypass translation
      const addressBytes = unsignedBigIntToBytes(new Uint8Array(8), va);
      const storeResult = await prepareStoreAccess({
        registers,
        memory,
        address: addressBytes,
        byteLength: 8,
      });

      assert(!storeResult.denied, 'M-mode store with MPRV=0 should succeed (physical access)');
      assert.deepEqual(storeResult.physicalAddress, addressBytes, 'PA should equal VA');
    });

    it('M-mode AMO with satp=Sv39 and MPRV=0: bypasses translation (physical access)', async () => {
      const memory = testMemory(0x10000n);
      const registers = createRegisters();
      const va = 0x8000_a000n; // Virtual address that will NOT have page table mapping

      // Enable Sv39 with root at PA 0x1000 (page table will be EMPTY)
      enableSv39(registers, 0x1000n);

      // Set M-mode with MPRV=0 (default)
      setPrivilegeMode(registers, PRIVILEGE_MACHINE);
      const mstatus = new Uint8Array(8);
      mstatus[0] = 0x00;
      mstatus[1] = 0x00;
      mstatus[2] = 0x00; // MPRV=0
      writeControlAndStatusRegister(registers, MSTATUS, mstatus);

      // AMO access should succeed despite satp being active
      // M-mode with MPRV=0 should bypass translation
      const addressBytes = unsignedBigIntToBytes(new Uint8Array(8), va);
      const amoResult = await prepareAtomicAccess({
        registers,
        memory,
        address: addressBytes,
        byteLength: 8,
        atomicAccess: 'amo',
      });

      assert(!amoResult.denied, 'M-mode AMO with MPRV=0 should succeed (physical access)');
      assert.deepEqual(amoResult.physicalAddress, addressBytes, 'PA should equal VA');
    });

    it('M-mode load with satp=Sv39, MPRV=1, MPP=M: bypasses translation (physical access)', async () => {
      const memory = testMemory(0x10000n);
      const registers = createRegisters();
      const va = 0x8000_c000n; // Virtual address that will NOT have page table mapping

      enableSv39(registers, 0x1000n);
      setPrivilegeMode(registers, PRIVILEGE_MACHINE);

      // MPRV=1, MPP=M (mstatus[12:11]=11 → byte1 bits 4:3 = 11 → 0x18)
      const mstatus = new Uint8Array(8);
      mstatus[0] = 0x00;
      mstatus[1] = 0x18; // MPP=M
      mstatus[2] = 0x02; // MPRV=1 (bit 17 → byte2 bit 1)
      writeControlAndStatusRegister(registers, MSTATUS, mstatus);

      const addressBytes = unsignedBigIntToBytes(new Uint8Array(8), va);
      const loadResult = await prepareLoadAccess({
        registers,
        memory,
        address: addressBytes,
        byteLength: 8,
      });

      assert(!loadResult.denied, 'M-mode load with MPRV=1, MPP=M should succeed');
      assert.deepEqual(loadResult.physicalAddress, addressBytes);
    });

    it('M-mode store with satp=Sv39, MPRV=1, MPP=S: uses MPP=S privilege for translation', async () => {
      const memory = testMemory(0x10000n);
      const registers = createRegisters();
      const va = 0x8000_1000n; // Virtual address we'll map
      const pa = 0xd000n; // Physical address
      const ppn = pa >> 12n;

      // Build mapping: root at 0x1000, VA 0x8000_1000 -> PA 0xd000
      const l2Index = Number((va >> 30n) & 0x1ffn);
      const l1Index = Number((va >> 21n) & 0x1ffn);
      const l0Index = Number((va >> 12n) & 0x1ffn);
      await storePte(memory, 0x1000n + BigInt(l2Index) * 8n, makePointerPte(0x2000n >> 12n));
      await storePte(memory, 0x2000n + BigInt(l1Index) * 8n, makePointerPte(0x3000n >> 12n));
      await storePte(
        memory,
        0x3000n + BigInt(l0Index) * 8n,
        makeLeafPte(ppn, true, true, false) | PTE_D
      ); // R+W+D, not X

      enableSv39(registers, 0x1000n);
      setupPmpAllowAll(registers);
      setPrivilegeMode(registers, PRIVILEGE_MACHINE);

      // MPRV=1, MPP=S (mstatus[12:11]=01 → byte1 bits 4:3 = 01 → 0x08)
      const mstatus = new Uint8Array(8);
      mstatus[0] = 0x00;
      mstatus[1] = 0x08; // MPP=S
      mstatus[2] = 0x02; // MPRV=1
      writeControlAndStatusRegister(registers, MSTATUS, mstatus);

      const vaBytes = unsignedBigIntToBytes(new Uint8Array(8), va);
      const storeResult = await prepareStoreAccess({
        registers,
        memory,
        address: vaBytes,
        byteLength: 8,
      });

      assert(!storeResult.denied, 'M-mode store with MPRV=1, MPP=S should translate');
      const expectedPa = unsignedBigIntToBytes(new Uint8Array(8), pa);
      assert.deepEqual(storeResult.physicalAddress, expectedPa);
    });

    it('S-mode load with satp=Sv39: uses translation (no MPRV bypass)', async () => {
      const memory = testMemory(0x10000n);
      const registers = createRegisters();
      const va = 0x8000_2000n;
      const pa = 0xe000n;
      const ppn = pa >> 12n;

      // Build mapping
      const l2Index = Number((va >> 30n) & 0x1ffn);
      const l1Index = Number((va >> 21n) & 0x1ffn);
      const l0Index = Number((va >> 12n) & 0x1ffn);
      await storePte(memory, 0x4000n + BigInt(l2Index) * 8n, makePointerPte(0x5000n >> 12n));
      await storePte(memory, 0x5000n + BigInt(l1Index) * 8n, makePointerPte(0x6000n >> 12n));
      await storePte(memory, 0x6000n + BigInt(l0Index) * 8n, makeLeafPte(ppn, true, false, false)); // R only

      enableSv39(registers, 0x4000n);
      setupPmpAllowAll(registers);
      setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);

      const vaBytes = unsignedBigIntToBytes(new Uint8Array(8), va);
      const loadResult = await prepareLoadAccess({
        registers,
        memory,
        address: vaBytes,
        byteLength: 8,
      });

      assert(!loadResult.denied, 'S-mode load should translate');
      const expectedPa = unsignedBigIntToBytes(new Uint8Array(8), pa);
      assert.deepEqual(loadResult.physicalAddress, expectedPa);
    });
  });
});

// ── C1: Sv39 Translation Tests for Gate Functions ──────────────────────────

/**
 * Build a Sv39 page table for a given VA → PA mapping.
 * Computes indices from the VA and builds the full 3-level hierarchy.
 * The test fixture maps RAM at PA [0, 64KB), so PA must be < 0x10000.
 */
const buildSv39Mapping = async (
  memory: ReturnType<typeof testMemory>,
  registers: ReturnType<typeof createRegisters>,
  va: bigint,
  leafPte: bigint
): Promise<void> => {
  enableSv39(registers, 0n);
  const l2Index = Number((va >> 30n) & 0x1ffn);
  const l1Index = Number((va >> 21n) & 0x1ffn);
  const l0Index = Number((va >> 12n) & 0x1ffn);

  // Root[l2Index] → L1 at PA 0x1000
  await storePte(memory, 0n, makePointerPte(0x1n));
  // L1[l1Index] → L0 at PA 0x2000
  await storePte(memory, 0x1000n + BigInt(l1Index) * 8n, makePointerPte(0x2n));
  // L0[l0Index] leaf PTE
  await storePte(memory, 0x2000n + BigInt(l0Index) * 8n, leafPte);
};

describe('paging gates — Sv39 translation', () => {
  it('prepareLoadAccess returns the translated PA for a valid Sv39 mapping', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);
    // VA 0x801000 → PA 0x1000 (PPN=0x1, within test RAM [0, 64KB))
    await buildSv39Mapping(memory, registers, 0x801000n, makeLeafPte(0x1n));

    const result = await prepareLoadAccess({
      registers,
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x801000n),
      byteLength: 8,
    });

    assert(!result.denied);
    const pa = bytesToBigInt(result.physicalAddress);
    assert.equal(pa, 0x1000n, 'VA 0x801000 should translate to PA 0x1000');
  });

  it('prepareStoreAccess returns the translated PA for a valid Sv39 mapping', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);
    // Store needs R∧W in the leaf for Sv39 walk
    await buildSv39Mapping(
      memory,
      registers,
      0x801000n,
      makeLeafPte(0x1n) | PTE_R | PTE_W | PTE_A | PTE_D
    );

    const result = await prepareStoreAccess({
      registers,
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x801000n),
      byteLength: 8,
    });

    assert(!result.denied);
    const pa = bytesToBigInt(result.physicalAddress);
    assert.equal(pa, 0x1000n);
  });

  it('prepareAtomicAccess (LR) returns the translated PA for a valid Sv39 mapping', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);
    // LR is load-class: needs R bit. The gate uses 'store' for the walk which
    // checks W, so leaf needs R+W to pass the gate path. VA 0x801000 → PA 0x1000
    await buildSv39Mapping(
      memory,
      registers,
      0x801000n,
      makeLeafPte(0x1n) | PTE_R | PTE_W | PTE_A | PTE_D
    );

    const result = await prepareAtomicAccess({
      registers,
      memory,
      address: unsignedBigIntToBytes(new Uint8Array(8), 0x801000n),
      byteLength: 8,
      atomicAccess: 'lr',
    });

    assert(!result.denied);
    const pa = bytesToBigInt(result.physicalAddress);
    assert.equal(pa, 0x1000n);
  });

  it('prepareLoadAccess page-faults on unmapped VA with cause=13 and xtval=VA', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);

    // Build page table with valid leaf at L0[1] for 0x801000.
    // Test VA 0x800000 (l2Idx=0, l1Idx=0, l0Idx=0): L0[0] = 0 → unmapped.
    enableSv39(registers, 0n);
    await storePte(memory, 0n, makePointerPte(0x1n));
    await storePte(memory, 0x1000n, makePointerPte(0x2n));
    await storePte(memory, 0x2008n, makeLeafPte(0x1n));
    // L0[0] at PA 0x2000 is 0 → unmapped

    try {
      await prepareLoadAccess({
        registers,
        memory,
        address: unsignedBigIntToBytes(new Uint8Array(8), 0x800000n),
        byteLength: 8,
      });
      assert.fail('expected page fault');
    } catch {
      const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
      assert.equal(mcause, CAUSE_LOAD_PAGE_FAULT);
      const mtval = bytesToBigInt(registers.controlAndStatus[0x343]!);
      assert.equal(mtval, 0x800000n);
    }
  });

  it('prepareStoreAccess page-faults on unmapped VA with cause=15 and xtval=VA', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);

    enableSv39(registers, 0n);
    await storePte(memory, 0n, makePointerPte(0x1n));
    await storePte(memory, 0x1000n, makePointerPte(0x2n));
    await storePte(memory, 0x2008n, makeLeafPte(0x1n));

    try {
      await prepareStoreAccess({
        registers,
        memory,
        address: unsignedBigIntToBytes(new Uint8Array(8), 0x800000n),
        byteLength: 8,
      });
      assert.fail('expected page fault');
    } catch {
      const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
      assert.equal(mcause, CAUSE_STORE_AMO_PAGE_FAULT);
      const mtval = bytesToBigInt(registers.controlAndStatus[0x343]!);
      assert.equal(mtval, 0x800000n);
    }
  });

  it('prepareAtomicAccess (SC) page-faults on unmapped VA with cause=15 and xtval=VA', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);

    enableSv39(registers, 0n);
    await storePte(memory, 0n, makePointerPte(0x1n));
    await storePte(memory, 0x1000n, makePointerPte(0x2n));
    await storePte(memory, 0x2008n, makeLeafPte(0x1n));

    try {
      await prepareAtomicAccess({
        registers,
        memory,
        address: unsignedBigIntToBytes(new Uint8Array(8), 0x800000n),
        byteLength: 8,
        atomicAccess: 'sc',
      });
      assert.fail('expected page fault');
    } catch {
      const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
      assert.equal(mcause, CAUSE_STORE_AMO_PAGE_FAULT);
      const mtval = bytesToBigInt(registers.controlAndStatus[0x343]!);
      assert.equal(mtval, 0x800000n);
    }
  });

  it('prepareAtomicAccess (SC) faults with cause=15 when leaf is W-only (needs R∧W)', async () => {
    const memory = testMemory(0x10000n);
    const registers = createRegisters();
    setPrivilegeMode(registers, PRIVILEGE_SUPERVISOR);
    setupPmpAllowAll(registers);

    // W-only leaf: R=0, W=1, A=1. For SC (store-class), walkPageTable uses 'store'
    // access type which checks W bit (passes) then checks A bit (passes since A=1).
    // But handleAdBits requires D bit for store-class access; D=0 and ADUE disabled
    // → throws page fault. This pins the bug class where a store-class access
    // to a non-D page without ADUE fails before reaching PMP/mapped checks.
    const wOnlyLeaf = PTE_V | PTE_W | PTE_A;
    // PA = 0x5000 (PPN=0x500 → within test RAM).

    enableSv39(registers, 0n);
    await storePte(memory, 0n, makePointerPte(0x1n));
    await storePte(memory, 0x1000n, makePointerPte(0x2n));
    // PPN=0x500 → PA 0x5000 (within test RAM)
    await storePte(memory, 0x2008n, wOnlyLeaf);

    try {
      await prepareAtomicAccess({
        registers,
        memory,
        address: unsignedBigIntToBytes(new Uint8Array(8), 0x801000n),
        byteLength: 8,
        atomicAccess: 'sc',
      });
      assert.fail('expected page fault');
    } catch {
      const mcause = bytesToNumber(registers.controlAndStatus[0x342]!);
      assert.equal(mcause, CAUSE_STORE_AMO_PAGE_FAULT);
      const mtval = bytesToBigInt(registers.controlAndStatus[0x343]!);
      assert.equal(mtval, 0x801000n);
    }
  });
});
