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
import {
  addBytes,
  andBytes,
  compareUnsignedBytes,
  copyBytes,
  orBytes,
  signedNumberToBytes,
} from '#utils/bytes';
import type { ReadonlyUint8Array } from '#types';

/** Number of integer general-purpose registers (x0–x31). */
const GENERAL_PURPOSE_REGISTER_COUNT = 32;

/** CSR indices are 12-bit (0–4095); the ISA calls this the CSR address. */
const CONTROL_AND_STATUS_REGISTER_COUNT = 4096;

/** Privilege modes (numeric order matches CSR address encoding). */
const PRIVILEGE_USER = signedNumberToBytes(new Uint8Array(8), 0, 32) as ReadonlyUint8Array;
const PRIVILEGE_SUPERVISOR = signedNumberToBytes(new Uint8Array(8), 1, 32) as ReadonlyUint8Array;
const PRIVILEGE_HYPERVISOR = signedNumberToBytes(new Uint8Array(8), 2, 32) as ReadonlyUint8Array;
const PRIVILEGE_MACHINE = signedNumberToBytes(new Uint8Array(8), 3, 32) as ReadonlyUint8Array;

/** Index by CSR address bits [9:8] → minimum privilege bytes. */
const PRIVILEGE_BY_CSR_LEVEL = [
  PRIVILEGE_USER,
  PRIVILEGE_SUPERVISOR,
  PRIVILEGE_HYPERVISOR,
  PRIVILEGE_MACHINE,
] as const;

/** Supervisor-mode CSRs. */
const SSTATUS = 0x100; // S-visible status (masked view of mstatus)
const SIE = 0x104; // S-visible interrupt enables (masked view of mie)
const STVEC = 0x105; // S-mode trap handler address
const SEPC = 0x141; // PC saved on trap to S
const SCAUSE = 0x142; // exception/interrupt code for S traps
const STVAL = 0x143; // faulting address/instruction for S traps
const SIP = 0x144; // S-visible interrupt pending (masked view of mip)

/** Machine-mode CSRs used by trap entry, `mret`, and delegation. */
const MSTATUS = 0x300; // global status / interrupt enables / prior privilege
const MEDELEG = 0x302; // which exceptions are delegated to S
const MIDELEG = 0x303; // which interrupts are delegated to S
const MIE = 0x304; // machine interrupt-enable bits
const MTVEC = 0x305; // M-mode trap handler address
const MEPC = 0x341; // PC saved on trap to M
const MCAUSE = 0x342; // exception/interrupt code for M traps
const MTVAL = 0x343; // faulting address/instruction for M traps
const MIP = 0x344; // machine interrupt-pending bits

/** Identity CSR addresses (implemented read-only). */
const MVENDORID = 0xf11; // JEDEC vendor id (hardwired 0)
const MARCHID = 0xf12; // architecture id (hardwired 0)
const MIMPID = 0xf13; // implementation id (hardwired 0)
const MHARTID = 0xf14; // hardware thread id (hardwired 0)

/**
 * sstatus is a restricted view of mstatus. Masked fields: SIE, SPIE, SPP, SUM, MXR.
 * (FS/XS/SD/UXL omitted until FP / wider WARL work lands. TW/TSR/TVM are M-only.)
 */
const SSTATUS_MASK_BYTES = Uint8Array.of(0x22, 0x01, 0x0c, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/** Bits of mstatus outside the sstatus view (inverse of {@link SSTATUS_MASK_BYTES}). */
const MSTATUS_KEEP_OUTSIDE_SSTATUS = Uint8Array.of(
  0xdd,
  0xfe,
  0xf3,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff
) as ReadonlyUint8Array;

/**
 * Implemented interrupt enable bits in mie: SSI, MSI, STI, MTI, SEI, MEI
 * (bits 1, 3, 5, 7, 9, 11) → 0xaaa. Other bits are WPRI (read as zero, writes ignored).
 */
const MIE_MASK_BYTES = Uint8Array.of(0xaa, 0x0a, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/**
 * Software-writable mip bits: SSI, STI (bits 1, 5) → 0x22.
 * MSIP/MTIP (CLINT) and SEIP/MEIP (PLIC) are hardware-driven and preserved across CSR writes.
 */
const MIP_WRITABLE_MASK_BYTES = Uint8Array.of(0x22, 0, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/** mip bits driven by devices: MSIP (3) + MTIP (7) + SEIP (9) + MEIP (11) → 0xa88. */
const MIP_HARDWARE_MASK_BYTES = Uint8Array.of(0x88, 0x0a, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/** sip software-writable pending bits (SSIP/STIP only; SEIP is PLIC-driven). */
const SIP_WRITABLE_MASK_BYTES = Uint8Array.of(0x22, 0, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/** mip.MTIP — machine timer interrupt pending (byte0 bit 7). */
const MIP_BYTE0_MTIP = 0x80;

/** mip.MSIP — machine software interrupt pending (byte0 bit 3). */
const MIP_BYTE0_MSIP = 0x08;

/** mip.MEIP — machine external interrupt pending (byte1 bit 3). */
const MIP_BYTE1_MEIP = 0x08;

/** mip.SEIP — supervisor external interrupt pending (byte1 bit 1). */
const MIP_BYTE1_SEIP = 0x02;

/** Bits of mie/mip outside the sie/sip view (inverse of SIE_SIP_MASK). */
const MIE_MIP_KEEP_OUTSIDE_SIE_SIP = Uint8Array.of(
  0xdd,
  0xfd,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff
) as ReadonlyUint8Array;

/**
 * sie/sip show only supervisor interrupt bits: SSI, STI, SEI (bits 1, 5, 9) → 0x222.
 */
const SIE_SIP_MASK_BYTES = Uint8Array.of(0x22, 0x02, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/**
 * mideleg WARL: only supervisor interrupt causes (SSI/STI/SEI) are delegatable here.
 * Machine interrupts (MSI/MTI/MEI) always target M.
 */
const MIDELEG_MASK_BYTES = Uint8Array.of(0x22, 0x02, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/**
 * MPP ("machine previous privilege") — mstatus bits 12:11, stored in byte1 bits 4:3.
 * On trap entry MPP ← current mode; on mret privilege ← MPP and MPP ← U (user).
 */
const MSTATUS_BYTE1_MPP_MASK = 0x18; // bits 12:11
const MSTATUS_BYTE1_MPP_USER = 0x00; // MPP = U user (00)
const MSTATUS_BYTE1_MPP_SUPERVISOR = 0x08; // MPP = S supervisor (01)
const MSTATUS_BYTE1_MPP_MACHINE = 0x18; // MPP = M machine (11)
/** Reserved MPP encoding (was H hypervisor); WARL to U (user). */
const MSTATUS_BYTE1_MPP_RESERVED = 0x10; // MPP = 10 (illegal)

const isIdentityControlAndStatusRegister = (index: number): boolean =>
  index === MVENDORID || index === MARCHID || index === MIMPID || index === MHARTID;

const isImplementedControlAndStatusRegister = (index: number): boolean =>
  index === SSTATUS ||
  index === SIE ||
  index === STVEC ||
  index === SEPC ||
  index === SCAUSE ||
  index === STVAL ||
  index === SIP ||
  index === MSTATUS ||
  index === MEDELEG ||
  index === MIDELEG ||
  index === MIE ||
  index === MTVEC ||
  index === MEPC ||
  index === MCAUSE ||
  index === MTVAL ||
  index === MIP ||
  isIdentityControlAndStatusRegister(index);

const isReadOnlyControlAndStatusRegister = (index: number): boolean =>
  isIdentityControlAndStatusRegister(index);

/** CSR address bits [9:8] encode the minimum privilege required to access it. */
const controlAndStatusRegisterRequiredPrivilege = (index: number): ReadonlyUint8Array =>
  PRIVILEGE_BY_CSR_LEVEL[(index >>> 8) & 0x3]!;

/**
 * Whether a CSR instruction may complete. Non-existent indices and insufficient
 * privilege are illegal on any access; read-only CSRs are illegal only when writing.
 */
const isControlAndStatusRegisterAccessAllowed = (
  registers: Registers,
  index: number,
  writes: boolean
): boolean => {
  if (!isImplementedControlAndStatusRegister(index)) {
    return false;
  }
  if (
    compareUnsignedBytes(
      registers.privilegeMode,
      controlAndStatusRegisterRequiredPrivilege(index)
    ) < 0
  ) {
    return false;
  }
  if (writes && isReadOnlyControlAndStatusRegister(index)) {
    return false;
  }
  return true;
};

/** The 0 and 1 that slt/slti/sltu/sltiu write to rd. */
const REGISTER_ZERO_BYTES = new Uint8Array(8) as ReadonlyUint8Array;
const REGISTER_ONE_BYTES = signedNumberToBytes(new Uint8Array(8), 1, 32) as ReadonlyUint8Array;

const FOUR_BYTES = signedNumberToBytes(new Uint8Array(8), 4, 32) as ReadonlyUint8Array;

const createRegisters = (): Registers => {
  const generalPurpose = Array.from(
    { length: GENERAL_PURPOSE_REGISTER_COUNT },
    () => new Uint8Array(8)
  );

  const controlAndStatus = Array.from(
    { length: CONTROL_AND_STATUS_REGISTER_COUNT },
    () => new Uint8Array(8)
  );

  return {
    generalPurpose: generalPurpose as unknown as Registers['generalPurpose'],
    programCounter: new Uint8Array(8),
    controlAndStatus: controlAndStatus as unknown as Registers['controlAndStatus'],
    privilegeMode: copyBytes(new Uint8Array(8), PRIVILEGE_MACHINE),
  };
};

const readPrivilegeMode = (registers: Registers): ReadonlyUint8Array => registers.privilegeMode;

const setPrivilegeMode = (registers: Registers, mode: ReadonlyUint8Array): Uint8Array =>
  copyBytes(registers.privilegeMode, mode);

const writeGeneralPurposeRegister = (
  registers: Registers,
  index: number,
  value: ReadonlyUint8Array
): ReadonlyUint8Array => {
  // x0 is hardwired zero: architectural writes are ignored.
  if (index === 0) {
    return registers.generalPurpose[0];
  }
  return copyBytes(registers.generalPurpose[index]!, value);
};

const readGeneralPurposeRegister = (registers: Registers, index: number): ReadonlyUint8Array =>
  registers.generalPurpose[index]!;

const setBooleanGeneralPurposeRegister = (
  registers: Registers,
  index: number,
  condition: boolean
): ReadonlyUint8Array =>
  writeGeneralPurposeRegister(
    registers,
    index,
    condition ? REGISTER_ONE_BYTES : REGISTER_ZERO_BYTES
  );

const readProgramCounter = (registers: Registers): ReadonlyUint8Array => registers.programCounter;

const setProgramCounter = (registers: Registers, value: ReadonlyUint8Array): Uint8Array =>
  copyBytes(registers.programCounter, value);

const advanceProgramCounter = (registers: Registers): Uint8Array =>
  addBytes(registers.programCounter, registers.programCounter, FOUR_BYTES);

/**
 * Keep mstatus.MPP legal on write. `mret` restores privilege from MPP, so a reserved
 * encoding (10, old H) must not stick — turn it into U so return always has a real mode.
 */
const legalizeMstatus = (mstatus: Uint8Array): Uint8Array => {
  const mppBits = mstatus[1]! & MSTATUS_BYTE1_MPP_MASK;
  if (mppBits === MSTATUS_BYTE1_MPP_RESERVED) {
    mstatus[1] = (mstatus[1]! & ~MSTATUS_BYTE1_MPP_MASK) | MSTATUS_BYTE1_MPP_USER;
  }
  return mstatus;
};

const readControlAndStatusRegister = (registers: Registers, index: number): ReadonlyUint8Array => {
  switch (index) {
    case SSTATUS:
      return andBytes(new Uint8Array(8), registers.controlAndStatus[MSTATUS]!, SSTATUS_MASK_BYTES);
    case SIE:
      return andBytes(new Uint8Array(8), registers.controlAndStatus[MIE]!, SIE_SIP_MASK_BYTES);
    case SIP:
      return andBytes(new Uint8Array(8), registers.controlAndStatus[MIP]!, SIE_SIP_MASK_BYTES);
    default:
      return registers.controlAndStatus[index]!;
  }
};

/** Copy a CSR; the file slot is live and must not be used as a mutable old value. */
const snapshotControlAndStatusRegister = (registers: Registers, index: number): Uint8Array =>
  copyBytes(new Uint8Array(8), readControlAndStatusRegister(registers, index));

const writeControlAndStatusRegister = (
  registers: Registers,
  index: number,
  value: ReadonlyUint8Array
): ReadonlyUint8Array => {
  // Identity CSRs are hardwired; guest CSR instructions must trap before calling this.
  if (isIdentityControlAndStatusRegister(index)) {
    return registers.controlAndStatus[index]!;
  }
  switch (index) {
    case SSTATUS: {
      // sstatus has no slot of its own: merge the writable S-visible bits into mstatus
      // and leave M-only fields (MIE, MPIE, MPP, …) unchanged.
      const mstatus = snapshotControlAndStatusRegister(registers, MSTATUS);
      const cleared = andBytes(new Uint8Array(8), mstatus, MSTATUS_KEEP_OUTSIDE_SSTATUS);
      const incoming = andBytes(new Uint8Array(8), value, SSTATUS_MASK_BYTES);
      return copyBytes(
        registers.controlAndStatus[MSTATUS]!,
        orBytes(new Uint8Array(8), cleared, incoming)
      );
    }
    case SIE: {
      const mie = snapshotControlAndStatusRegister(registers, MIE);
      const cleared = andBytes(new Uint8Array(8), mie, MIE_MIP_KEEP_OUTSIDE_SIE_SIP);
      const incoming = andBytes(new Uint8Array(8), value, SIE_SIP_MASK_BYTES);
      return copyBytes(
        registers.controlAndStatus[MIE]!,
        orBytes(new Uint8Array(8), cleared, incoming)
      );
    }
    case SIP: {
      // Clear only SSIP/STIP; preserve SEIP (PLIC) and all non-S pending bits.
      const mip = snapshotControlAndStatusRegister(registers, MIP);
      const keep = orBytes(
        new Uint8Array(8),
        andBytes(new Uint8Array(8), mip, MIE_MIP_KEEP_OUTSIDE_SIE_SIP),
        andBytes(new Uint8Array(8), mip, MIP_HARDWARE_MASK_BYTES)
      );
      const incoming = andBytes(new Uint8Array(8), value, SIP_WRITABLE_MASK_BYTES);
      return copyBytes(
        registers.controlAndStatus[MIP]!,
        orBytes(new Uint8Array(8), keep, incoming)
      );
    }
    case MSTATUS:
      // Store mstatus after forcing MPP to a legal encoding.
      return copyBytes(
        registers.controlAndStatus[MSTATUS]!,
        legalizeMstatus(copyBytes(new Uint8Array(8), value))
      );
    case MIE:
      return copyBytes(
        registers.controlAndStatus[MIE]!,
        andBytes(new Uint8Array(8), value, MIE_MASK_BYTES)
      );
    case MIP: {
      // Preserve device-driven MSIP/MTIP/SEIP/MEIP; only software-writable pending bits update.
      const previous = registers.controlAndStatus[MIP]!;
      const writable = andBytes(new Uint8Array(8), value, MIP_WRITABLE_MASK_BYTES);
      const hardware = andBytes(new Uint8Array(8), previous, MIP_HARDWARE_MASK_BYTES);
      return copyBytes(
        registers.controlAndStatus[MIP]!,
        orBytes(new Uint8Array(8), writable, hardware)
      );
    }
    case MIDELEG:
      return copyBytes(
        registers.controlAndStatus[MIDELEG]!,
        andBytes(new Uint8Array(8), value, MIDELEG_MASK_BYTES)
      );
    default:
      return copyBytes(registers.controlAndStatus[index]!, value);
  }
};

const privilegeModeFromMppBits = (mppBits: number): ReadonlyUint8Array => {
  if (mppBits === MSTATUS_BYTE1_MPP_MACHINE) {
    return PRIVILEGE_MACHINE;
  }
  if (mppBits === MSTATUS_BYTE1_MPP_SUPERVISOR) {
    return PRIVILEGE_SUPERVISOR;
  }
  return PRIVILEGE_USER;
};

const mppBitsFromPrivilegeMode = (mode: ReadonlyUint8Array): number => {
  if (compareUnsignedBytes(mode, PRIVILEGE_MACHINE) === 0) {
    return MSTATUS_BYTE1_MPP_MACHINE;
  }
  if (compareUnsignedBytes(mode, PRIVILEGE_SUPERVISOR) === 0) {
    return MSTATUS_BYTE1_MPP_SUPERVISOR;
  }
  return MSTATUS_BYTE1_MPP_USER;
};

/** Set or clear mip.MTIP from the CLINT compare (not a guest CSR write). */
const setMachineTimerInterruptPending = (registers: Registers, pending: boolean): void => {
  const mip = registers.controlAndStatus[MIP]!;
  if (pending) {
    mip[0]! |= MIP_BYTE0_MTIP;
  } else {
    mip[0]! &= ~MIP_BYTE0_MTIP;
  }
};

/** Set or clear mip.MSIP from the CLINT msip register (not a guest CSR write). */
const setMachineSoftwareInterruptPending = (registers: Registers, pending: boolean): void => {
  const mip = registers.controlAndStatus[MIP]!;
  if (pending) {
    mip[0]! |= MIP_BYTE0_MSIP;
  } else {
    mip[0]! &= ~MIP_BYTE0_MSIP;
  }
};

/** Set or clear mip.MEIP from the PLIC machine context (not a guest CSR write). */
const setMachineExternalInterruptPending = (registers: Registers, pending: boolean): void => {
  const mip = registers.controlAndStatus[MIP]!;
  if (pending) {
    mip[1]! |= MIP_BYTE1_MEIP;
  } else {
    mip[1]! &= ~MIP_BYTE1_MEIP;
  }
};

/** Set or clear mip.SEIP from the PLIC supervisor context (not a guest CSR write). */
const setSupervisorExternalInterruptPending = (registers: Registers, pending: boolean): void => {
  const mip = registers.controlAndStatus[MIP]!;
  if (pending) {
    mip[1]! |= MIP_BYTE1_SEIP;
  } else {
    mip[1]! &= ~MIP_BYTE1_SEIP;
  }
};

export {
  PRIVILEGE_USER,
  PRIVILEGE_SUPERVISOR,
  PRIVILEGE_MACHINE,
  STVEC,
  SEPC,
  SCAUSE,
  STVAL,
  MSTATUS,
  MEDELEG,
  MIDELEG,
  MIE,
  MTVEC,
  MEPC,
  MCAUSE,
  MTVAL,
  MIP,
  MSTATUS_BYTE1_MPP_MASK,
  MSTATUS_BYTE1_MPP_USER,
  FOUR_BYTES,
  createRegisters,
  readPrivilegeMode,
  setPrivilegeMode,
  writeGeneralPurposeRegister,
  readGeneralPurposeRegister,
  setBooleanGeneralPurposeRegister,
  readProgramCounter,
  setProgramCounter,
  advanceProgramCounter,
  snapshotControlAndStatusRegister,
  writeControlAndStatusRegister,
  isControlAndStatusRegisterAccessAllowed,
  privilegeModeFromMppBits,
  mppBitsFromPrivilegeMode,
  setMachineTimerInterruptPending,
  setMachineSoftwareInterruptPending,
  setMachineExternalInterruptPending,
  setSupervisorExternalInterruptPending,
};
