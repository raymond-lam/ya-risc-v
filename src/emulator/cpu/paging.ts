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
import {
  copyBytes,
  bytesToBigInt,
  unsignedBigIntToBytes,
  addBytes,
  compareUnsignedBytes,
} from '#utils/bytes';
import { loadBytes, storeBytes, guestAccessIsMapped } from '#emulator/memory';
import { physicalMemoryAccessDenied } from '#emulator/cpu/pmp';
import type { ReadonlyUint8Array } from '#types';
import {
  CAUSE_INSTRUCTION_ACCESS_FAULT,
  CAUSE_LOAD_ACCESS_FAULT,
  CAUSE_STORE_AMO_ACCESS_FAULT,
  CAUSE_INSTRUCTION_PAGE_FAULT,
  CAUSE_LOAD_PAGE_FAULT,
  CAUSE_STORE_AMO_PAGE_FAULT,
  CAUSE_LOAD_ADDRESS_MISALIGNED,
  CAUSE_STORE_AMO_ADDRESS_MISALIGNED,
  enterTrap,
} from '#emulator/cpu/trap';
import {
  satpRootTablePhysicalAddress,
  satpTranslationIsActive,
  readPrivilegeMode,
  readProgramCounter,
  PRIVILEGE_MACHINE,
  PRIVILEGE_SUPERVISOR,
  PRIVILEGE_USER,
  MSTATUS,
  menvcfgAdueIsEnabled,
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
const pageFaultCauseForType = (accessType: 'fetch' | 'load' | 'store' | 'amo'): number => {
  switch (accessType) {
    case 'fetch':
      return CAUSE_INSTRUCTION_PAGE_FAULT;
    case 'load':
      return CAUSE_LOAD_PAGE_FAULT;
    case 'store':
    case 'amo':
      return CAUSE_STORE_AMO_PAGE_FAULT;
  }
};

/**
 * Determine which access-fault cause to use for the given original access type.
 */
const accessFaultCauseForType = (accessType: 'fetch' | 'load' | 'store' | 'amo'): number => {
  switch (accessType) {
    case 'fetch':
      return CAUSE_INSTRUCTION_ACCESS_FAULT;
    case 'load':
      return CAUSE_LOAD_ACCESS_FAULT;
    case 'store':
    case 'amo':
      return CAUSE_STORE_AMO_ACCESS_FAULT;
  }
};

// ── B2: Leaf Permission & A/D Bit Logic ────────────────────────────────────

/** MSTATUS bit masks */
const MSTATUS_BYTE2_SUM = 0x04; // Bit 18
const MSTATUS_BYTE2_MXR = 0x08; // Bit 19

/**
 * Determine effective privilege based on current mode and MPRV/MPP.
 */
const determineEffectivePrivilege = (registers: Registers): ReadonlyUint8Array => {
  const currentMode = readPrivilegeMode(registers);
  const mstatus = registers.controlAndStatus[MSTATUS]!;
  const mprv = (mstatus[2]! & 0x04) !== 0; // Bit 17

  if (compareUnsignedBytes(currentMode, PRIVILEGE_MACHINE) !== 0 || !mprv) {
    return currentMode;
  }

  const mpp = mstatus[1]! & 0x06; // Bits 11:10
  if (mpp === 0) return PRIVILEGE_MACHINE;
  if (mpp === 0x04) return PRIVILEGE_SUPERVISOR;
  return PRIVILEGE_USER;
};

/**
 * Check U-bit permission for the given access type and effective privilege.
 */
const checkUbitPermission = (
  pteValue: bigint,
  effectivePrivilege: ReadonlyUint8Array,
  accessType: 'fetch' | 'load' | 'store' | 'amo',
  mstatus: ReadonlyUint8Array
): void => {
  if (!pteIsUser(pteValue)) return; // Non-user PTE: no U-bit check needed

  const isUserPriv = compareUnsignedBytes(effectivePrivilege, PRIVILEGE_USER) === 0;
  if (isUserPriv) return; // U-mode can access U pages

  const isSupervisor = compareUnsignedBytes(effectivePrivilege, PRIVILEGE_SUPERVISOR) === 0;
  if (!isSupervisor) return; // M-mode can access U pages

  // S-mode: fetch is never SUM-gated
  if (accessType === 'fetch') {
    throw createPageFaultError(pageFaultCauseForType(accessType));
  }

  // Load/store: require SUM
  const sum = (mstatus[2]! & MSTATUS_BYTE2_SUM) !== 0;
  if (!sum) {
    throw createPageFaultError(pageFaultCauseForType(accessType));
  }
};

/**
 * Check fetch permissions (X bit required).
 */
const checkFetchPermission = (
  pteValue: bigint,
  accessType: 'fetch' | 'load' | 'store' | 'amo'
): void => {
  if (!pteIsExecutable(pteValue)) {
    throw createPageFaultError(pageFaultCauseForType(accessType));
  }
};

/**
 * Check load permissions (R bit, or MXR+X at S-mode).
 */
const checkLoadPermission = (
  pteValue: bigint,
  effectivePrivilege: ReadonlyUint8Array,
  accessType: 'fetch' | 'load' | 'store' | 'amo',
  mstatus: ReadonlyUint8Array
): void => {
  if (pteIsReadable(pteValue)) return;

  if (compareUnsignedBytes(effectivePrivilege, PRIVILEGE_SUPERVISOR) === 0) {
    // MXR allows S-mode to load from X-only pages
    const mxr = (mstatus[2]! & MSTATUS_BYTE2_MXR) !== 0;
    if (mxr && pteIsExecutable(pteValue)) return;
  }
  throw createPageFaultError(pageFaultCauseForType(accessType));
};

/**
 * Check store permissions (W bit required).
 */
const checkStorePermission = (
  pteValue: bigint,
  accessType: 'fetch' | 'load' | 'store' | 'amo'
): void => {
  if (!pteIsWritable(pteValue)) {
    throw createPageFaultError(pageFaultCauseForType(accessType));
  }
};

/**
 * Check AMO permissions (R+W required).
 */
const checkAmoPermission = (
  pteValue: bigint,
  accessType: 'fetch' | 'load' | 'store' | 'amo'
): void => {
  if (!pteIsReadable(pteValue) || !pteIsWritable(pteValue)) {
    throw createPageFaultError(pageFaultCauseForType(accessType));
  }
};

/**
 * Check R/W/X permission bits based on access type.
 */
const checkAccessPermissions = (
  pteValue: bigint,
  effectivePrivilege: ReadonlyUint8Array,
  accessType: 'fetch' | 'load' | 'store' | 'amo',
  mstatus: ReadonlyUint8Array
): void => {
  switch (accessType) {
    case 'fetch':
      checkFetchPermission(pteValue, accessType);
      break;
    case 'load':
      checkLoadPermission(pteValue, effectivePrivilege, accessType, mstatus);
      break;
    case 'store':
      checkStorePermission(pteValue, accessType);
      break;
    case 'amo':
      checkAmoPermission(pteValue, accessType);
      break;
  }
};

/**
 * Handle A/D bit checking and updates per ADUE setting.
 */
const handleAdBits = async (
  registers: Registers,
  memory: Memory,
  pteValue: bigint,
  ptePa: ReadonlyUint8Array,
  accessType: 'fetch' | 'load' | 'store' | 'amo'
): Promise<void> => {
  const adueEnabled = menvcfgAdueIsEnabled(registers);
  let needsUpdate = false;
  let newPteValue = pteValue;

  // A bit: required for all accesses
  if (!pteIsAccessed(pteValue)) {
    if (!adueEnabled) {
      throw createPageFaultError(pageFaultCauseForType(accessType));
    }
    newPteValue |= 64n; // Set A bit
    needsUpdate = true;
  }

  // D bit: required for store-class accesses
  if (accessType === 'store' || accessType === 'amo') {
    if (!pteIsDirty(pteValue)) {
      if (!adueEnabled) {
        throw createPageFaultError(pageFaultCauseForType(accessType));
      }
      newPteValue |= 128n; // Set D bit
      needsUpdate = true;
    }
  }

  // Write updated PTE if needed
  if (needsUpdate) {
    const newPteBytes = unsignedBigIntToBytes(new Uint8Array(8), newPteValue);
    await storeBytes({ memory, address: ptePa, source: newPteBytes, byteLength: 8 });
  }
};

/**
 * Checks leaf PTE permissions (U-bit, R/W/X) and handles A/D bit updates.
 * Throws PageFaultError on permission violations or A/D faults.
 * Updates memory with A/D bits if ADUE is enabled.
 */
const checkLeafPermissionsAndHandleAD = async (
  registers: Registers,
  memory: Memory,
  pteValue: bigint,
  ptePa: ReadonlyUint8Array,
  level: number,
  accessType: 'fetch' | 'load' | 'store' | 'amo'
): Promise<void> => {
  // 1. Superpage alignment checks
  if (level === 2 && !isLevel2Aligned(pteValue)) {
    throw createPageFaultError(pageFaultCauseForType(accessType));
  }
  if (level === 1 && !isLevel1Aligned(pteValue)) {
    throw createPageFaultError(pageFaultCauseForType(accessType));
  }

  // 2. Determine effective privilege
  const effectivePrivilege = determineEffectivePrivilege(registers);
  const mstatus = registers.controlAndStatus[MSTATUS]!;

  // 3. U-bit check
  checkUbitPermission(pteValue, effectivePrivilege, accessType, mstatus);

  // 4. Permission bits check
  checkAccessPermissions(pteValue, effectivePrivilege, accessType, mstatus);

  // 5. A/D bit handling
  await handleAdBits(registers, memory, pteValue, ptePa, accessType);
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
  originalAccessType: 'fetch' | 'load' | 'store' | 'amo'
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
  originalAccessType: 'fetch' | 'load' | 'store' | 'amo'
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
      // 5b. Check permissions and handle A/D updates
      await checkLeafPermissionsAndHandleAD(
        registers,
        memory,
        pteValue,
        ptePaBytes,
        level,
        originalAccessType
      );
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

// ── B3: Gate helpers & translated fetch ────────────────────────────────────

/** Result of prepare*Access gate helpers. */
export type PreparedAccess =
  { readonly denied: true } | { readonly denied: false; readonly physicalAddress: Uint8Array };

/** Atomic access subtypes for prepareAtomicAccess. */
type AtomicAccess = 'lr' | 'sc' | 'amo';

/**
 * Construct a physical address from a leaf PTE and virtual address.
 *
 * @param pteValue - Leaf PTE value
 * @param virtualAddress - Original virtual address as bigint
 * @param level - Page-table level of the leaf (0, 1, or 2)
 * @returns Physical address as a fresh 8-byte LE buffer
 */
export const constructPhysicalAddress = (
  pteValue: bigint,
  virtualAddress: bigint,
  level: number
): Uint8Array => {
  const ppn = ptePhysicalPageNumber(pteValue);
  // For Sv39, PPN is stored at bits [53:10] of the PTE.
  // The physical address is (PPN << 12) | (VA & offset_mask).
  const offsetMask = (1n << BigInt(PAGE_OFFSET_BITS + LEVEL_INDEX_BITS * level)) - 1n;
  const pa = (ppn << 12n) | (virtualAddress & offsetMask);
  return unsignedBigIntToBytes(new Uint8Array(8), pa);
};

/**
 * Prepare a load access: translate (if needed), check permissions, update A/D,
 * check PMP/mapped on final PA, and return the physical address.
 *
 * Bare mode (satp.MODE=Bare): returns VA as PA without translation.
 * M-mode with MPRV+MPP=M: returns VA as PA (physical access, no translation).
 *
 * On failure: calls `enterTrap` and returns `{ denied: true }`.
 * On success: returns `{ denied: false, physicalAddress }`.
 */
export const prepareLoadAccess = async (params: {
  registers: Registers;
  memory: Memory;
  address: ReadonlyUint8Array;
  byteLength: number;
}): Promise<PreparedAccess> => {
  const { registers, memory, address, byteLength } = params;
  const va = bytesToBigInt(address);

  // Bare mode: return VA as PA
  if (!satpTranslationIsActive(registers)) {
    return { denied: false, physicalAddress: copyBytes(new Uint8Array(8), address) };
  }

  // Determine effective privilege (load honors MPRV)
  const effectivePrivilege = determineEffectivePrivilege(registers);
  const mstatus = registers.controlAndStatus[MSTATUS]!;

  // MPRV+MPP=M: physical access (no translation)
  if (compareUnsignedBytes(effectivePrivilege, PRIVILEGE_MACHINE) === 0) {
    if ((mstatus[2]! & 0x04) !== 0) {
      // MPRV set
      const mpp = mstatus[1]! & 0x06;
      if (mpp === 0) {
        // MPP=M
        return { denied: false, physicalAddress: copyBytes(new Uint8Array(8), address) };
      }
    }
  }

  // Walk the page table
  try {
    const walkResult = await walkPageTable(registers, memory, address, 'load');
    if (!walkResult.success) {
      enterTrap(registers, CAUSE_LOAD_PAGE_FAULT, copyBytes(new Uint8Array(8), address));
      return { denied: true };
    }

    // Superpage alignment checks
    if (walkResult.level === 1 && !isLevel1Aligned(walkResult.leafPteValue)) {
      enterTrap(registers, CAUSE_LOAD_PAGE_FAULT, copyBytes(new Uint8Array(8), address));
      return { denied: true };
    }
    if (walkResult.level === 2 && !isLevel2Aligned(walkResult.leafPteValue)) {
      enterTrap(registers, CAUSE_LOAD_PAGE_FAULT, copyBytes(new Uint8Array(8), address));
      return { denied: true };
    }

    // Permission and A/D handled inside walkPageTable → checkLeafPermissionsAndHandleAD

    // Construct physical address
    const pa = constructPhysicalAddress(walkResult.leafPteValue, va, walkResult.level);

    // PMP check on final PA
    if (physicalMemoryAccessDenied({ registers, address: pa, byteLength, access: 'load' })) {
      enterTrap(registers, CAUSE_LOAD_ACCESS_FAULT, copyBytes(new Uint8Array(8), address));
      return { denied: true };
    }

    // Mapped check on final PA
    if (!guestAccessIsMapped({ memory, address: pa, byteLength })) {
      enterTrap(registers, CAUSE_LOAD_ACCESS_FAULT, copyBytes(new Uint8Array(8), address));
      return { denied: true };
    }

    return { denied: false, physicalAddress: pa };
  } catch (error: unknown) {
    // PageFaultError from walkPageTable
    enterTrap(registers, CAUSE_LOAD_PAGE_FAULT, copyBytes(new Uint8Array(8), address));
    return { denied: true };
  }
};

/**
 * Prepare a store access: translate (if needed), check permissions, update A/D,
 * check PMP/mapped on final PA, and return the physical address.
 *
 * Bare mode: returns VA as PA without translation.
 * M-mode with MPRV+MPP=M: returns VA as PA.
 *
 * On failure: calls `enterTrap` and returns `{ denied: true }`.
 * On success: returns `{ denied: false, physicalAddress }`.
 */
export const prepareStoreAccess = async (params: {
  registers: Registers;
  memory: Memory;
  address: ReadonlyUint8Array;
  byteLength: number;
}): Promise<PreparedAccess> => {
  const { registers, memory, address, byteLength } = params;
  const va = bytesToBigInt(address);

  // Bare mode: return VA as PA
  if (!satpTranslationIsActive(registers)) {
    return { denied: false, physicalAddress: copyBytes(new Uint8Array(8), address) };
  }

  // Determine effective privilege (store honors MPRV)
  const effectivePrivilege = determineEffectivePrivilege(registers);
  const mstatus = registers.controlAndStatus[MSTATUS]!;

  // MPRV+MPP=M: physical access (no translation)
  if (compareUnsignedBytes(effectivePrivilege, PRIVILEGE_MACHINE) === 0) {
    if ((mstatus[2]! & 0x04) !== 0) {
      // MPRV set
      const mpp = mstatus[1]! & 0x06;
      if (mpp === 0) {
        // MPP=M
        return { denied: false, physicalAddress: copyBytes(new Uint8Array(8), address) };
      }
    }
  }

  // Walk the page table
  try {
    const walkResult = await walkPageTable(registers, memory, address, 'store');
    if (!walkResult.success) {
      enterTrap(registers, CAUSE_STORE_AMO_PAGE_FAULT, copyBytes(new Uint8Array(8), address));
      return { denied: true };
    }

    // Superpage alignment checks
    if (walkResult.level === 1 && !isLevel1Aligned(walkResult.leafPteValue)) {
      enterTrap(registers, CAUSE_STORE_AMO_PAGE_FAULT, copyBytes(new Uint8Array(8), address));
      return { denied: true };
    }
    if (walkResult.level === 2 && !isLevel2Aligned(walkResult.leafPteValue)) {
      enterTrap(registers, CAUSE_STORE_AMO_PAGE_FAULT, copyBytes(new Uint8Array(8), address));
      return { denied: true };
    }

    // Construct physical address
    const pa = constructPhysicalAddress(walkResult.leafPteValue, va, walkResult.level);

    // PMP check on final PA
    if (physicalMemoryAccessDenied({ registers, address: pa, byteLength, access: 'store' })) {
      enterTrap(registers, CAUSE_STORE_AMO_ACCESS_FAULT, copyBytes(new Uint8Array(8), address));
      return { denied: true };
    }

    // Mapped check on final PA
    if (!guestAccessIsMapped({ memory, address: pa, byteLength })) {
      enterTrap(registers, CAUSE_STORE_AMO_ACCESS_FAULT, copyBytes(new Uint8Array(8), address));
      return { denied: true };
    }

    return { denied: false, physicalAddress: pa };
  } catch (error: unknown) {
    enterTrap(registers, CAUSE_STORE_AMO_PAGE_FAULT, copyBytes(new Uint8Array(8), address));
    return { denied: true };
  }
};

/**
 * Walk, check superpage alignment, construct PA, and check PMP/mapped.
 * Returns physical address on success, or calls enterTrap and returns null.
 */
const walkAndCheckAtomicPA = async (
  registers: Registers,
  memory: Memory,
  address: ReadonlyUint8Array,
  byteLength: number,
  pageFaultCause: number,
  accessFaultCause: number
): Promise<Uint8Array | null> => {
  const va = bytesToBigInt(address);
  const safeResult = await safeWalk(registers, memory, address, 'store');

  if (!safeResult.ok) {
    enterTrap(registers, pageFaultCause, copyBytes(new Uint8Array(8), address));
    return null;
  }

  const walkResult = safeResult.result;

  // Superpage alignment checks
  if (walkResult.level === 1 && !isLevel1Aligned(walkResult.leafPteValue)) {
    enterTrap(registers, pageFaultCause, copyBytes(new Uint8Array(8), address));
    return null;
  }
  if (walkResult.level === 2 && !isLevel2Aligned(walkResult.leafPteValue)) {
    enterTrap(registers, pageFaultCause, copyBytes(new Uint8Array(8), address));
    return null;
  }

  // Construct physical address
  const pa = constructPhysicalAddress(walkResult.leafPteValue, va, walkResult.level);

  // PMP check on final PA
  if (physicalMemoryAccessDenied({ registers, address: pa, byteLength, access: 'store' })) {
    enterTrap(registers, accessFaultCause, copyBytes(new Uint8Array(8), address));
    return null;
  }

  // Mapped check on final PA
  if (!guestAccessIsMapped({ memory, address: pa, byteLength })) {
    enterTrap(registers, accessFaultCause, copyBytes(new Uint8Array(8), address));
    return null;
  }

  return pa;
};

/**
 * Check natural alignment for an atomic access address.
 * Traps with the appropriate misaligned cause if the VA is misaligned.
 */
const checkAtomicAlignment = (
  registers: Registers,
  address: ReadonlyUint8Array,
  byteLength: number,
  atomicAccess: AtomicAccess
): boolean => {
  const va = bytesToBigInt(address);
  if (va % BigInt(byteLength) !== 0n) {
    const cause =
      atomicAccess === 'lr' ? CAUSE_LOAD_ADDRESS_MISALIGNED : CAUSE_STORE_AMO_ADDRESS_MISALIGNED;
    enterTrap(registers, cause, copyBytes(new Uint8Array(8), address));
    return false;
  }
  return true;
};

/**
 * Prepare an atomic access (LR/SC/AMO): translate, check permissions, update A/D,
 * check alignment, PMP/mapped on final PA, and return the physical address.
 *
 * Bare mode: natural-VA alignment → return VA as PA.
 * Translated access (Sv39, effective privilege < M): walkPageTable → superpage
 * alignment on leaf → construct PA → PMP → mapped → natural-VA alignment.
 * In translated mode page fault has priority over address-misaligned per the
 * spec exception priority table.
 *
 * LR: treats as load-class (needs R, sets A only).
 * SC/AMO: treat as store-class (needs R+W, sets A+D).
 *
 * On failure: calls `enterTrap` and returns `{ denied: true }`.
 * On success: returns `{ denied: false, physicalAddress }`.
 */
export const prepareAtomicAccess = async (params: {
  registers: Registers;
  memory: Memory;
  address: ReadonlyUint8Array;
  byteLength: 4 | 8;
  atomicAccess: AtomicAccess;
}): Promise<PreparedAccess> => {
  const { registers, memory, address, byteLength, atomicAccess } = params;

  // Bare mode: alignment first, then return VA as PA.
  if (!satpTranslationIsActive(registers)) {
    if (!checkAtomicAlignment(registers, address, byteLength, atomicAccess)) {
      return { denied: true };
    }
    return { denied: false, physicalAddress: copyBytes(new Uint8Array(8), address) };
  }

  // Determine effective privilege
  const effectivePrivilege = determineEffectivePrivilege(registers);
  const mstatus = registers.controlAndStatus[MSTATUS]!;

  // MPRV+MPP=M: physical access (no translation)
  if (compareUnsignedBytes(effectivePrivilege, PRIVILEGE_MACHINE) === 0) {
    if ((mstatus[2]! & 0x04) !== 0) {
      const mpp = mstatus[1]! & 0x06;
      if (mpp === 0) {
        return { denied: false, physicalAddress: copyBytes(new Uint8Array(8), address) };
      }
    }
  }

  // Determine access type for permission checks
  // LR treats as load-class; SC/AMO treat as store-class
  const accessType: 'load' | 'store' = atomicAccess === 'lr' ? 'load' : 'store';
  const pageFaultCause = atomicAccess === 'lr' ? CAUSE_LOAD_PAGE_FAULT : CAUSE_STORE_AMO_PAGE_FAULT;
  const accessFaultCause =
    atomicAccess === 'lr' ? CAUSE_LOAD_ACCESS_FAULT : CAUSE_STORE_AMO_ACCESS_FAULT;

  // Walk, PMP/mapped, then alignment — for translated accesses page fault
  // must take priority over address-misaligned (spec priority table).
  const pa = await walkAndCheckAtomicPA(
    registers,
    memory,
    address,
    byteLength,
    pageFaultCause,
    accessFaultCause
  );
  if (pa === null) {
    return { denied: true };
  }

  // Alignment check on VA after translation for Sv39.
  if (!checkAtomicAlignment(registers, address, byteLength, atomicAccess)) {
    return { denied: true };
  }

  return { denied: false, physicalAddress: pa };
};

/**
 * Result of a safe walk: the walk result if successful, or undefined if a page fault occurred.
 */
type SafeWalkResult =
  | {
      readonly ok: true;
      readonly result: {
        readonly success: true;
        readonly leafPtePa: Uint8Array;
        readonly leafPteValue: bigint;
        readonly level: number;
      };
    }
  | { readonly ok: false };

/**
 * Safe wrapper around walkPageTable that converts page-fault errors to a discriminated union.
 * Uses try/catch with explicit error typing to avoid unsafe-assignment errors.
 */
const safeWalk = async (
  registers: Registers,
  memory: Memory,
  address: ReadonlyUint8Array,
  accessType: 'fetch' | 'load' | 'store' | 'amo'
): Promise<SafeWalkResult> => {
  try {
    const walk = await walkPageTable(registers, memory, address, accessType);
    if (walk.success) {
      return {
        ok: true,
        result: {
          success: true,
          leafPtePa: walk.leafPtePa,
          leafPteValue: walk.leafPteValue,
          level: walk.level,
        },
      };
    }
    return { ok: false };
  } catch (error: unknown) {
    // PageFaultError or other runtime error — treat as page fault
    if (!(error instanceof Error)) {
      return { ok: false };
    }
    return { ok: false };
  }
};

/**
 * Safe wrapper around walkPageTable for fetch operations.
 * Returns the walk result on success, or null if a page fault occurred.
 */
const safeWalkForFetch = async (
  registers: Registers,
  memory: Memory,
  address: ReadonlyUint8Array
): Promise<{
  readonly success: true;
  readonly leafPtePa: Uint8Array;
  readonly leafPteValue: bigint;
  readonly level: number;
} | null> => {
  const result = await safeWalk(registers, memory, address, 'fetch');
  if (result.ok) {
    return result.result;
  }
  return null;
};

/**
 * Walk the page table for fetch and check permissions/A/D/PMP/mapped.
 * Returns the physical address on success, or calls enterTrap and returns null.
 */
const fetchParcelWalk = async (
  registers: Registers,
  memory: Memory,
  address: ReadonlyUint8Array,
  trapValue: ReadonlyUint8Array
): Promise<Uint8Array | null> => {
  const walkResult = await safeWalkForFetch(registers, memory, address);
  if (walkResult === null) {
    enterTrap(registers, CAUSE_INSTRUCTION_PAGE_FAULT, copyBytes(new Uint8Array(8), trapValue));
    return null;
  }

  // Superpage alignment checks
  if (walkResult.level === 1 && !isLevel1Aligned(walkResult.leafPteValue)) {
    enterTrap(registers, CAUSE_INSTRUCTION_PAGE_FAULT, copyBytes(new Uint8Array(8), trapValue));
    return null;
  }
  if (walkResult.level === 2 && !isLevel2Aligned(walkResult.leafPteValue)) {
    enterTrap(registers, CAUSE_INSTRUCTION_PAGE_FAULT, copyBytes(new Uint8Array(8), trapValue));
    return null;
  }

  // Construct physical address
  const pa = constructPhysicalAddress(
    walkResult.leafPteValue,
    bytesToBigInt(address),
    walkResult.level
  );

  // PMP check
  if (physicalMemoryAccessDenied({ registers, address: pa, byteLength: 2, access: 'fetch' })) {
    enterTrap(registers, CAUSE_INSTRUCTION_ACCESS_FAULT, copyBytes(new Uint8Array(8), trapValue));
    return null;
  }

  // Mapped check
  if (!guestAccessIsMapped({ memory, address: pa, byteLength: 2 })) {
    enterTrap(registers, CAUSE_INSTRUCTION_ACCESS_FAULT, copyBytes(new Uint8Array(8), trapValue));
    return null;
  }

  return pa;
};

/**
 * Prepare a fetch parcel (one 2-byte half of a potential 4-byte instruction).
 * Uses fetch privilege rules (ignores MPRV, no SUM/MXR).
 *
 * On failure: calls `enterTrap` and returns `{ denied: true }`.
 * On success: returns `{ denied: false, physicalAddress }`.
 */
export const prepareFetchParcel = async (params: {
  registers: Registers;
  memory: Memory;
  address: ReadonlyUint8Array;
  trapValue: ReadonlyUint8Array;
}): Promise<PreparedAccess> => {
  const { registers, memory, address, trapValue } = params;

  // Fetch ignores MPRV — use current privilege mode
  const currentPrivilege = readPrivilegeMode(registers);

  // M-mode fetch: always physical (no translation)
  if (compareUnsignedBytes(currentPrivilege, PRIVILEGE_MACHINE) === 0) {
    if (physicalMemoryAccessDenied({ registers, address, byteLength: 2, access: 'fetch' })) {
      enterTrap(registers, CAUSE_INSTRUCTION_ACCESS_FAULT, copyBytes(new Uint8Array(8), trapValue));
      return { denied: true };
    }
    if (!guestAccessIsMapped({ memory, address, byteLength: 2 })) {
      enterTrap(registers, CAUSE_INSTRUCTION_ACCESS_FAULT, copyBytes(new Uint8Array(8), trapValue));
      return { denied: true };
    }
    return { denied: false, physicalAddress: copyBytes(new Uint8Array(8), address) };
  }

  // Bare mode: return address as PA
  if (!satpTranslationIsActive(registers)) {
    return { denied: false, physicalAddress: copyBytes(new Uint8Array(8), address) };
  }

  // Translated fetch: walk + check + PA construction
  const pa: Uint8Array | null = await fetchParcelWalk(registers, memory, address, trapValue);
  if (pa === null) {
    return { denied: true };
  }
  return { denied: false, physicalAddress: pa };
};

/**
 * Fetch a translated instruction: assemble 4 bytes from two 2-byte parcels.
 * Returns false if any trap occurred (caller continues loop); on success,
 * instructionBytes contains the assembled word.
 *
 * The instructionBytes buffer is mutated in place on success.
 * PC is never advanced by this function — the caller handles that.
 */
export const fetchTranslatedInstruction = async (params: {
  registers: Registers;
  memory: Memory;
  instructionBytes: Uint8Array;
}): Promise<boolean> => {
  const { registers, memory, instructionBytes } = params;
  const pc = readProgramCounter(registers);

  // Parcel 1 at PC (2 bytes)
  const parcel1 = await prepareFetchParcel({ registers, memory, address: pc, trapValue: pc });
  if (parcel1.denied) return false;
  const parcel1Pa = parcel1.physicalAddress;

  await loadBytes({
    destination: instructionBytes.subarray(0, 2),
    memory,
    address: parcel1Pa,
    byteLength: 2,
  });

  // Check if 32-bit instruction
  const is32Bit = (instructionBytes[0]! & 0x03) !== 0x03; // ENCODING_LENGTH_MASK = 0x03, 32-bit = 0x03
  if (is32Bit === false) {
    // Compressed instruction (2 bytes)
    return true;
  }

  // Parcel 2 at PC+2 (2 bytes)
  const pcPlus2 = copyBytes(new Uint8Array(8), pc);
  addBytes(pcPlus2, pcPlus2, unsignedBigIntToBytes(new Uint8Array(8), 2n));
  const parcel2 = await prepareFetchParcel({ registers, memory, address: pcPlus2, trapValue: pc });
  if (parcel2.denied) return false;
  const parcel2Pa = parcel2.physicalAddress;

  await loadBytes({
    destination: instructionBytes.subarray(2, 4),
    memory,
    address: parcel2Pa,
    byteLength: 2,
  });

  return true;
};

export { createPageFaultError, walkPageTable };
