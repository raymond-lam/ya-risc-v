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

import type { Registers } from '#emulator/cpu/types';
import type { Memory } from '#emulator/memory';
import { copyBytes, bytesToBigInt, unsignedBigIntToBytes, addBytes } from '#utils/bytes';
import { loadBytes, guestAccessIsMapped } from '#emulator/memory';
import { physicalMemoryAccessDenied } from '#emulator/cpu/pmp';
import type { ReadonlyUint8Array } from '#types';
import {
  CAUSE_INSTRUCTION_ACCESS_FAULT,
  CAUSE_LOAD_ACCESS_FAULT,
  CAUSE_STORE_AMO_ACCESS_FAULT,
  CAUSE_INSTRUCTION_PAGE_FAULT,
  CAUSE_LOAD_PAGE_FAULT,
  CAUSE_STORE_AMO_PAGE_FAULT,
  enterTrap,
} from '#emulator/cpu/trap';
import {
  satpRootTablePhysicalAddress,
  readPrivilegeMode,
  PRIVILEGE_MACHINE,
} from '#emulator/cpu/registers';

// ── Sv39 constants ────────────────────────────────────────────────────────

/** Sv39 mode value in satp.MODE field (bits [63:60]). */
export const SATP_MODE_SV39 = 8;

/** Sv39 page size in bytes (4 KiB). */
export const PAGE_SIZE = 4096;

/** Number of page-table levels for Sv39. */
export const PAGE_TABLE_LEVELS = 3;

/** Bits per page-table level index (9 bits per level). */
export const LEVEL_INDEX_BITS = 9;

/** Offset bits within a page (12 bits). */
export const PAGE_OFFSET_BITS = 12;

// ── Page-fault error type ─────────────────────────────────────────────────

/**
 * Thrown when the walk encounters a page-fault condition (V=0, invalid R/W,
 * or pointer at level 0). Callers must catch and call `enterTrap` with the
 * appropriate page-fault cause (12/13/15).
 * Contains a `cause` property for test assertions.
 */
const createPageFaultError = (cause: number): Error => {
  const error = new Error(`Page fault (cause ${cause})`);
  (error as Error & { cause: number }).cause = cause;
  return error;
};

// ── PTE field-extraction helpers (frozen exports) ─────────────────────────

/** Extract V (valid) bit from PTE value (bit 0). */
export const pteIsValid = (pteValue: bigint): boolean => (pteValue & 1n) !== 0n;

/** Extract R (read) bit from PTE value (bit 1). */
export const pteIsReadable = (pteValue: bigint): boolean => (pteValue & 2n) !== 0n;

/** Extract W (write) bit from PTE value (bit 2). */
export const pteIsWritable = (pteValue: bigint): boolean => (pteValue & 4n) !== 0n;

/** Extract X (execute) bit from PTE value (bit 3). */
export const pteIsExecutable = (pteValue: bigint): boolean => (pteValue & 8n) !== 0n;

/** Extract U (user) bit from PTE value (bit 4). */
export const pteIsUser = (pteValue: bigint): boolean => (pteValue & 16n) !== 0n;

/** Extract A (accessed) bit from PTE value (bit 6). */
export const pteIsAccessed = (pteValue: bigint): boolean => (pteValue & 64n) !== 0n;

/** Extract D (dirty) bit from PTE value (bit 7). */
export const pteIsDirty = (pteValue: bigint): boolean => (pteValue & 128n) !== 0n;

/**
 * Extract PPN (physical page number) from PTE value.
 * Bits [53:10] — 44 bits of PPN.
 */
export const ptePhysicalPageNumber = (pteValue: bigint): bigint =>
  (pteValue >> 10n) & ((1n << 44n) - 1n);

// ── Superpage alignment helpers (frozen exports) ──────────────────────────

/**
 * Check level-2 (1 GiB) superpage alignment: PPN[1:0] must be 0.
 */
export const isLevel2Aligned = (pteValue: bigint): boolean => {
  const ppn = ptePhysicalPageNumber(pteValue);
  return (ppn & 3n) === 0n;
};

/**
 * Check level-1 (2 MiB) superpage alignment: PPN[0] must be 0.
 */
export const isLevel1Aligned = (pteValue: bigint): boolean => {
  const ppn = ptePhysicalPageNumber(pteValue);
  return (ppn & 1n) === 0n;
};

// ── Internal types ────────────────────────────────────────────────────────

type WalkResult =
  | { readonly success: false; readonly trapCause: number }
  | {
      readonly success: true;
      readonly leafPtePa: Uint8Array;
      readonly leafPteValue: bigint;
      readonly level: number;
    };

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Determine which page-fault cause to use for the given access type.
 */
const pageFaultCauseForType = (accessType: 'fetch' | 'load' | 'store'): number => {
  switch (accessType) {
    case 'fetch':
      return CAUSE_INSTRUCTION_PAGE_FAULT;
    case 'load':
      return CAUSE_LOAD_PAGE_FAULT;
    case 'store':
      return CAUSE_STORE_AMO_PAGE_FAULT;
  }
};

/**
 * Determine which access-fault cause to use for the given original access type.
 */
const accessFaultCauseForType = (accessType: 'fetch' | 'load' | 'store'): number => {
  switch (accessType) {
    case 'fetch':
      return CAUSE_INSTRUCTION_ACCESS_FAULT;
    case 'load':
      return CAUSE_LOAD_ACCESS_FAULT;
    case 'store':
      return CAUSE_STORE_AMO_ACCESS_FAULT;
  }
};

/**
 * Check whether a Sv39 virtual address has the correct sign-extension.
 * Bits 63:48 must equal bit 47.
 */
export const isCanonicalVa = (va: bigint): boolean => {
  // Sv39 uses 48-bit virtual addresses. Bits 63:48 must equal bit 47.
  const upperBits = (va >> 48n) & 0xffffn;
  const signBit = (va >> 47n) & 1n;
  if (signBit === 0n) {
    return upperBits === 0n;
  }
  return upperBits === 0xffffn;
};

/**
 * Compute the page-table index at a given level.
 * Level 2 → bits 47:39, level 1 → bits 38:30, level 0 → bits 29:21.
 */
const pteIndexAtLevel = (virtualAddress: bigint, level: number): number => {
  const shift = PAGE_OFFSET_BITS + LEVEL_INDEX_BITS * level;
  return Number((virtualAddress >> BigInt(shift)) & 0x1ffn);
};

/**
 * Check if a PTE is a leaf.
 * A PTE is a leaf if R=1 or X=1.
 */
const isLeafPte = (pteValue: bigint): boolean =>
  pteIsReadable(pteValue) || pteIsExecutable(pteValue);

/**
 * Read a PTE from physical memory with PMP and mapped checks.
 * On PMP denial or unmapped PTE PA: calls `enterTrap` (synchronous, writes tval)
 * and throws. The tval is a copy of the `va` that was passed to `walkPageTable`.
 */
const readPte = async (
  registers: Registers,
  memory: Memory,
  ptePa: ReadonlyUint8Array,
  va: ReadonlyUint8Array,
  originalAccessType: 'fetch' | 'load' | 'store'
): Promise<bigint> => {
  // 1. PMP check on the 8-byte PTE load at the effective privilege
  if (physicalMemoryAccessDenied({ registers, address: ptePa, byteLength: 8, access: 'load' })) {
    enterTrap(
      registers,
      accessFaultCauseForType(originalAccessType),
      copyBytes(new Uint8Array(8), va)
    );
    throw new Error('trap delivered — unreachable');
  }

  // 2. Mapped check before attempting to read
  if (!guestAccessIsMapped({ memory, address: ptePa, byteLength: 8 })) {
    enterTrap(
      registers,
      accessFaultCauseForType(originalAccessType),
      copyBytes(new Uint8Array(8), va)
    );
    throw new Error('trap delivered — unreachable');
  }

  // 3. Load the 8-byte PTE
  const buf = new Uint8Array(8);
  await loadBytes({ destination: buf, memory, address: ptePa, byteLength: 8 });
  return bytesToBigInt(buf);
};

// ── Core walk engine ──────────────────────────────────────────────────────

/**
 * Walk the Sv39 page table for the given virtual address.
 *
 * @param registers - Hart state (privilege mode used for PMP checks on PTE reads).
 * @param memory - Physical memory (PTE reads go through this).
 * @param virtualAddress - The VA to translate (8-byte little-endian).
 * @param originalAccessType - 'fetch' | 'load' | 'store' — determines which
 *   access-fault cause to use if a PTE read is denied by PMP or is unmapped.
 *
 * On PMP denial or unmapped PTE PA: calls `enterTrap` (which writes tval = VA
 * *copy*) and throws. The trap cause matches the original access class.
 *
 * On page-fault conditions (V=0, R=0∧W=1, pointer-at-level-0): throws a
 * `PageFaultError` so callers can catch and call `enterTrap` with the correct
 * page-fault cause (12/13/15).
 *
 * On successful leaf: returns a result with the leaf PTE's physical address,
 * the PTE value as bigint, and the level at which the leaf was found.
 */
const walkPageTable = async (
  registers: Registers,
  memory: Memory,
  virtualAddress: ReadonlyUint8Array,
  originalAccessType: 'fetch' | 'load' | 'store'
): Promise<WalkResult> => {
  const va = bytesToBigInt(virtualAddress);

  // 1. Canonical VA check
  if (!isCanonicalVa(va)) {
    throw createPageFaultError(pageFaultCauseForType(originalAccessType));
  }

  const rootPa = satpRootTablePhysicalAddress(registers);
  let tablePa = copyBytes(new Uint8Array(8), rootPa);

  // 2. Walk levels 2 → 0
  for (let level = 2; level >= 0; level -= 1) {
    const index = pteIndexAtLevel(va, level);

    // Compute PTE physical address: tablePa + (index * 8)
    const ptePaBytes = copyBytes(new Uint8Array(8), tablePa);
    const offset = unsignedBigIntToBytes(new Uint8Array(8), BigInt(index * 8));
    addBytes(ptePaBytes, ptePaBytes, offset);

    // Read PTE with PMP and mapped checks (traps on access fault)
    const pteValue = await readPte(
      registers,
      memory,
      ptePaBytes,
      virtualAddress,
      originalAccessType
    );

    // 3. Valid bit check
    if (!pteIsValid(pteValue)) {
      throw createPageFaultError(pageFaultCauseForType(originalAccessType));
    }

    // 4. R=0, W=1 is an invalid combination → page fault
    if (!pteIsReadable(pteValue) && pteIsWritable(pteValue)) {
      throw createPageFaultError(pageFaultCauseForType(originalAccessType));
    }

    // 5. Leaf or pointer?
    if (isLeafPte(pteValue)) {
      return { success: true, leafPtePa: ptePaBytes, leafPteValue: pteValue, level };
    }

    // 6. Pointer at level 0 is an error (should have been a leaf)
    if (level === 0) {
      throw createPageFaultError(pageFaultCauseForType(originalAccessType));
    }

    // 7. Descend: next table = PPN << 12
    const ppn = ptePhysicalPageNumber(pteValue);
    tablePa = unsignedBigIntToBytes(new Uint8Array(8), ppn << 12n);
  }

  // Should never reach here — level -1 is invalid
  throw new Error('Unexpected page walk state');
};

export { createPageFaultError, walkPageTable };
