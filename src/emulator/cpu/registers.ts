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
import { readClintMtimeBytes } from '#emulator/clint';
import type { Memory } from '#emulator/memory';
import {
  addBytes,
  andBytes,
  compareUnsignedBytes,
  copyBytes,
  orBytes,
  signedNumberToBytes,
  unsignedBigIntToBytes,
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

/** Unprivileged counters (read-only; S/U gated by mcounteren / scounteren). */
const CYCLE = 0xc00; // alias of mcycle (read-only below M)
const TIME = 0xc01; // wall time — mirrors CLINT `mtime`
const INSTRET = 0xc02; // alias of minstret (read-only below M)

/** Supervisor-mode CSRs. */
const SSTATUS = 0x100; // S-visible status (masked view of mstatus)
const SIE = 0x104; // S-visible interrupt enables (masked view of mie)
const STVEC = 0x105; // S-mode trap handler address
const SCOUNTEREN = 0x106; // U-mode counter-enable (CY/TM/IR)
const SSCRATCH = 0x140; // scratch for S-mode trap handlers
const SEPC = 0x141; // PC saved on trap to S
const SCAUSE = 0x142; // exception/interrupt code for S traps
const STVAL = 0x143; // faulting address/instruction for S traps
const SIP = 0x144; // S-visible interrupt pending (masked view of mip)
const SATP = 0x180; // address translation / protection (stub until Sv39)

/** Machine-mode CSRs used by trap entry, `mret`, and delegation. */
const MSTATUS = 0x300; // global status / interrupt enables / prior privilege
const MISA = 0x301; // ISA and extensions (hardwired WARL)
const MEDELEG = 0x302; // which exceptions are delegated to S
const MIDELEG = 0x303; // which interrupts are delegated to S
const MIE = 0x304; // machine interrupt-enable bits
const MTVEC = 0x305; // M-mode trap handler address
const MCOUNTEREN = 0x306; // S/U counter-enable (CY/TM/IR)
const MCOUNTINHIBIT = 0x320; // freeze mcycle / minstret (CY/IR)
const MSCRATCH = 0x340; // scratch for M-mode trap handlers
const MEPC = 0x341; // PC saved on trap to M
const MCAUSE = 0x342; // exception/interrupt code for M traps
const MTVAL = 0x343; // faulting address/instruction for M traps
const MIP = 0x344; // machine interrupt-pending bits
/** Machine counters (canonical storage; `cycle` / `instret` alias these). */
const MCYCLE = 0xb00;
const MINSTRET = 0xb02;

/** Identity CSR addresses (implemented read-only). */
const MVENDORID = 0xf11; // JEDEC vendor id (hardwired 0)
const MARCHID = 0xf12; // architecture id (hardwired 0)
const MIMPID = 0xf13; // implementation id (hardwired 0)
const MHARTID = 0xf14; // hardware thread id (hardwired 0)

/**
 * Hardwired misa: MXL=64 (bits 63:62 = 2) and extensions A, C, I, M, S, U.
 * Update when F/D/… land. WARL writes are ignored (value stays fixed).
 */
const MISA_HARDWIRED_BYTES = unsignedBigIntToBytes(
  new Uint8Array(8),
  // MXL=2 at [63:62] | U | S | M | I | C | A
  (2n << 62n) | (1n << 20n) | (1n << 18n) | (1n << 12n) | (1n << 8n) | (1n << 2n) | (1n << 0n)
) as ReadonlyUint8Array;

/**
 * sstatus is a restricted view of mstatus. Masked fields: SIE, SPIE, SPP, SUM, MXR, UXL.
 * (FS/XS/SD omitted until FP work lands. TW/TSR/TVM/SXL are M-only.)
 */
const SSTATUS_MASK_BYTES = Uint8Array.of(0x22, 0x01, 0x0c, 0, 0x03, 0, 0, 0) as ReadonlyUint8Array;

/** Bits of mstatus outside the sstatus view (inverse of {@link SSTATUS_MASK_BYTES}). */
const MSTATUS_KEEP_OUTSIDE_SSTATUS = Uint8Array.of(
  0xdd,
  0xfe,
  0xf3,
  0xff,
  0xfc,
  0xff,
  0xff,
  0xff
) as ReadonlyUint8Array;

/**
 * mstatus.UXL (bits 33:32) and SXL (bits 35:34) hardwired to 64 (`2`).
 * Little-endian byte4: UXL → bits 1:0, SXL → bits 3:2 → 0b1010 = 0x0a.
 */
const MSTATUS_BYTE4_UXL_SXL_MASK = 0x0f;
const MSTATUS_BYTE4_UXL_SXL_64 = 0x0a;

/**
 * Implemented interrupt enable bits in mie: SSI, MSI, STI, MTI, SEI, MEI
 * (bits 1, 3, 5, 7, 9, 11) → 0xaaa. Other bits are WPRI (read as zero, writes ignored).
 */
const MIE_MASK_BYTES = Uint8Array.of(0xaa, 0x0a, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/**
 * Software-writable mip bits: SSI, STI, SEIP (bits 1, 5, 9) → 0x222.
 * MSIP/MTIP (CLINT) and MEIP (PLIC) are hardware-driven and preserved across CSR writes.
 * Readable SEIP is soft bit OR PLIC wire (see {@link readControlAndStatusRegister}).
 */
const MIP_WRITABLE_MASK_BYTES = Uint8Array.of(0x22, 0x02, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/** mip bits driven by devices in the CSR slot: MSIP (3) + MTIP (7) + MEIP (11) → 0x888. */
const MIP_HARDWARE_MASK_BYTES = Uint8Array.of(0x88, 0x08, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/** sip software-writable pending bits (SSIP/STIP only; SEIP is read-only in sip). */
const SIP_WRITABLE_MASK_BYTES = Uint8Array.of(0x22, 0, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/**
 * mcounteren / scounteren WARL: CY (bit 0), TM (bit 1), IR (bit 2). HPM bits stay
 * read-only zero until those counters exist.
 */
const COUNTEREN_MASK_BYTES = Uint8Array.of(0x07, 0, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/** mcountinhibit WARL: CY (bit 0) and IR (bit 2). Bit 1 is reserved (no TM inhibit). */
const MCOUNTINHIBIT_MASK_BYTES = Uint8Array.of(0x05, 0, 0, 0, 0, 0, 0, 0) as ReadonlyUint8Array;

/** mcounteren/scounteren/mcountinhibit.CY — `cycle` / `mcycle` (byte0 bit 0). */
const COUNTEREN_BYTE0_CY = 0x01;
/** mcounteren/scounteren.TM — allow `time` below M (byte0 bit 1). */
const COUNTEREN_BYTE0_TM = 0x02;
/** mcounteren/scounteren/mcountinhibit.IR — `instret` / `minstret` (byte0 bit 2). */
const COUNTEREN_BYTE0_IR = 0x04;

/** IALIGN=16 (C): mepc/sepc WARL clears bit [0] on write. */
const XEPC_IALIGN_MASK_BYTE0 = 0xfe;

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

const isUnprivilegedCounterControlAndStatusRegister = (index: number): boolean =>
  index === CYCLE || index === TIME || index === INSTRET;

const isImplementedControlAndStatusRegister = (index: number): boolean =>
  index === CYCLE ||
  index === TIME ||
  index === INSTRET ||
  index === SSTATUS ||
  index === SIE ||
  index === STVEC ||
  index === SCOUNTEREN ||
  index === SSCRATCH ||
  index === SEPC ||
  index === SCAUSE ||
  index === STVAL ||
  index === SIP ||
  index === SATP ||
  index === MSTATUS ||
  index === MISA ||
  index === MEDELEG ||
  index === MIDELEG ||
  index === MIE ||
  index === MTVEC ||
  index === MCOUNTEREN ||
  index === MCOUNTINHIBIT ||
  index === MSCRATCH ||
  index === MEPC ||
  index === MCAUSE ||
  index === MTVAL ||
  index === MIP ||
  index === MCYCLE ||
  index === MINSTRET ||
  isIdentityControlAndStatusRegister(index);

const isReadOnlyControlAndStatusRegister = (index: number): boolean =>
  isIdentityControlAndStatusRegister(index) || isUnprivilegedCounterControlAndStatusRegister(index);

/** CSR address bits [9:8] encode the minimum privilege required to access it. */
const controlAndStatusRegisterRequiredPrivilege = (index: number): ReadonlyUint8Array =>
  PRIVILEGE_BY_CSR_LEVEL[(index >>> 8) & 0x3]!;

/**
 * mstatus.TVM (Timeout Wait for Virtual Memory), bit 20 → little-endian bytes[2] bit 4.
 * When set, S-mode read/write of `satp` raises illegal-instruction (M still allowed).
 */
const MSTATUS_BYTE2_TVM = 0x10;

/** Enable bit in mcounteren/scounteren for an unprivileged counter CSR. */
const counterEnableBit = (index: number): number => {
  if (index === CYCLE) {
    return COUNTEREN_BYTE0_CY;
  }
  if (index === TIME) {
    return COUNTEREN_BYTE0_TM;
  }
  return COUNTEREN_BYTE0_IR;
};

/**
 * S/U access to `cycle`/`time` requires the matching `mcounteren` bit; U also needs
 * `scounteren`. M-mode always allowed.
 */
const isCounterAccessEnabled = (registers: Registers, index: number): boolean => {
  const enableBit = counterEnableBit(index);
  if (compareUnsignedBytes(registers.privilegeMode, PRIVILEGE_MACHINE) < 0) {
    if ((registers.controlAndStatus[MCOUNTEREN]![0]! & enableBit) === 0) {
      return false;
    }
  }
  if (compareUnsignedBytes(registers.privilegeMode, PRIVILEGE_USER) === 0) {
    if ((registers.controlAndStatus[SCOUNTEREN]![0]! & enableBit) === 0) {
      return false;
    }
  }
  return true;
};

/** `mstatus.TVM` blocks S-mode `satp` access. */
const isSatpBlockedByTvm = (registers: Registers, index: number): boolean =>
  index === SATP &&
  compareUnsignedBytes(registers.privilegeMode, PRIVILEGE_SUPERVISOR) === 0 &&
  (registers.controlAndStatus[MSTATUS]![2]! & MSTATUS_BYTE2_TVM) !== 0;

/**
 * Whether a CSR instruction may complete. Non-existent indices and insufficient
 * privilege are illegal on any access; read-only CSRs are illegal only when writing.
 * With `mstatus.TVM` set, S-mode access to `satp` is also illegal.
 * `cycle`/`time` below M need `mcounteren`; U-mode also needs `scounteren`.
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
  if (isSatpBlockedByTvm(registers, index)) {
    return false;
  }
  if (
    isUnprivilegedCounterControlAndStatusRegister(index) &&
    !isCounterAccessEnabled(registers, index)
  ) {
    return false;
  }
  return true;
};

/** The 0 and 1 that slt/slti/sltu/sltiu write to rd. */
const REGISTER_ZERO_BYTES = new Uint8Array(8) as ReadonlyUint8Array;
const REGISTER_ONE_BYTES = signedNumberToBytes(new Uint8Array(8), 1, 32) as ReadonlyUint8Array;

/** Encoded instruction width as an architectural byte delta (RVC = 2, 32-bit = 4). */
const TWO_BYTES = signedNumberToBytes(new Uint8Array(8), 2, 32) as ReadonlyUint8Array;
const FOUR_BYTES = signedNumberToBytes(new Uint8Array(8), 4, 32) as ReadonlyUint8Array;

/** Mark that the instruction about to execute should retire if it completes. */
const beginInstructionRetire = (registers: Registers): void => {
  registers.retireInstruction = true;
};

/** Cancel retire (trap / illegal / aborted execute). */
const cancelInstructionRetire = (registers: Registers): void => {
  registers.retireInstruction = false;
};

/**
 * If retire is still pending, bump `mcycle` / `minstret` unless frozen in `mcountinhibit`.
 * CPI = 1: one retired instruction advances both counters together.
 */
const commitInstructionRetire = (registers: Registers): void => {
  if (!registers.retireInstruction) {
    return;
  }
  registers.retireInstruction = false;
  const inhibit = registers.controlAndStatus[MCOUNTINHIBIT]![0]!;
  if ((inhibit & COUNTEREN_BYTE0_CY) === 0) {
    addBytes(
      registers.controlAndStatus[MCYCLE]!,
      registers.controlAndStatus[MCYCLE]!,
      REGISTER_ONE_BYTES
    );
  }
  if ((inhibit & COUNTEREN_BYTE0_IR) === 0) {
    addBytes(
      registers.controlAndStatus[MINSTRET]!,
      registers.controlAndStatus[MINSTRET]!,
      REGISTER_ONE_BYTES
    );
  }
};

/**
 * Retire now (for `ecall` / `ebreak`, whose defined behavior is to trap after retiring).
 */
const retireInstructionNow = (registers: Registers): void => {
  registers.retireInstruction = true;
  commitInstructionRetire(registers);
};

const createRegisters = (): Registers => {
  const generalPurpose = Array.from(
    { length: GENERAL_PURPOSE_REGISTER_COUNT },
    () => new Uint8Array(8)
  );

  const controlAndStatus = Array.from(
    { length: CONTROL_AND_STATUS_REGISTER_COUNT },
    () => new Uint8Array(8)
  );

  // Hardwire mstatus.UXL/SXL to 64 and misa (RV64IMAC + S/U) on reset.
  controlAndStatus[MSTATUS]![4] = MSTATUS_BYTE4_UXL_SXL_64;
  copyBytes(controlAndStatus[MISA]!, MISA_HARDWIRED_BYTES);

  return {
    generalPurpose: generalPurpose as unknown as Registers['generalPurpose'],
    programCounter: new Uint8Array(8),
    controlAndStatus: controlAndStatus as unknown as Registers['controlAndStatus'],
    privilegeMode: copyBytes(new Uint8Array(8), PRIVILEGE_MACHINE),
    plicSupervisorExternalPending: false,
    retireInstruction: false,
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

const advanceProgramCounter = (registers: Registers, byteLength: ReadonlyUint8Array): Uint8Array =>
  addBytes(registers.programCounter, registers.programCounter, byteLength);

/**
 * Keep mstatus.MPP legal on write. `mret` restores privilege from MPP, so a reserved
 * encoding (10, old H) must not stick — turn it into U so return always has a real mode.
 * Hardwire UXL/SXL to 64 (RV64).
 */
const legalizeMstatus = (mstatus: Uint8Array): Uint8Array => {
  const mppBits = mstatus[1]! & MSTATUS_BYTE1_MPP_MASK;
  if (mppBits === MSTATUS_BYTE1_MPP_RESERVED) {
    mstatus[1] = (mstatus[1]! & ~MSTATUS_BYTE1_MPP_MASK) | MSTATUS_BYTE1_MPP_USER;
  }
  mstatus[4] = (mstatus[4]! & ~MSTATUS_BYTE4_UXL_SXL_MASK) | MSTATUS_BYTE4_UXL_SXL_64;
  return mstatus;
};

/** IALIGN=16: clear bit 0 of mepc/sepc on CSR write. */
const legalizeXepc = (xepc: Uint8Array): Uint8Array => {
  xepc[0]! &= XEPC_IALIGN_MASK_BYTE0;
  return xepc;
};

/** Readable mip: CSR slot ORed with the PLIC supervisor-external wire into SEIP. */
const readMipWithPlicSeip = (registers: Registers): Uint8Array => {
  const mip = copyBytes(new Uint8Array(8), registers.controlAndStatus[MIP]!);
  if (registers.plicSupervisorExternalPending) {
    mip[1]! |= MIP_BYTE1_SEIP;
  }
  return mip;
};

const readControlAndStatusRegister = (
  registers: Registers,
  index: number,
  memory?: Memory
): ReadonlyUint8Array => {
  switch (index) {
    case TIME:
      // `time` mirrors CLINT `mtime` (sync-on-read). Callers that read TIME must pass memory.
      if (memory === undefined) {
        throw new TypeError('Reading the time CSR requires guest memory (CLINT mtime).');
      }
      return readClintMtimeBytes(memory, new Uint8Array(8));
    case CYCLE:
      return registers.controlAndStatus[MCYCLE]!;
    case INSTRET:
      return registers.controlAndStatus[MINSTRET]!;
    case SSTATUS:
      return andBytes(new Uint8Array(8), registers.controlAndStatus[MSTATUS]!, SSTATUS_MASK_BYTES);
    case SIE:
      return andBytes(new Uint8Array(8), registers.controlAndStatus[MIE]!, SIE_SIP_MASK_BYTES);
    case SIP:
      return andBytes(new Uint8Array(8), readMipWithPlicSeip(registers), SIE_SIP_MASK_BYTES);
    case MIP:
      return readMipWithPlicSeip(registers);
    default:
      return registers.controlAndStatus[index]!;
  }
};

/**
 * Copy a CSR; the file slot is live and must not be used as a mutable old value.
 * Pass `memory` when reading `time` (CLINT-backed).
 */
const snapshotControlAndStatusRegister = (
  registers: Registers,
  index: number,
  memory?: Memory
): Uint8Array =>
  copyBytes(new Uint8Array(8), readControlAndStatusRegister(registers, index, memory));

const writeControlAndStatusRegister = (
  registers: Registers,
  index: number,
  value: ReadonlyUint8Array
): ReadonlyUint8Array => {
  // Identity / unprivileged counters are hardwired or device-backed; guest CSR
  // instructions must trap before calling this for those indices.
  if (
    isIdentityControlAndStatusRegister(index) ||
    isUnprivilegedCounterControlAndStatusRegister(index)
  ) {
    return registers.controlAndStatus[index]!;
  }
  switch (index) {
    case SSTATUS: {
      // sstatus has no slot of its own: merge the writable S-visible bits into mstatus
      // and leave M-only fields (MIE, MPIE, MPP, …) unchanged; legalize hardwires UXL/SXL.
      const mstatus = snapshotControlAndStatusRegister(registers, MSTATUS);
      const cleared = andBytes(new Uint8Array(8), mstatus, MSTATUS_KEEP_OUTSIDE_SSTATUS);
      const incoming = andBytes(new Uint8Array(8), value, SSTATUS_MASK_BYTES);
      return copyBytes(
        registers.controlAndStatus[MSTATUS]!,
        legalizeMstatus(orBytes(new Uint8Array(8), cleared, incoming))
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
      // Clear only SSIP/STIP; preserve soft SEIP and all non-S pending bits (PLIC wire is separate).
      const mip = registers.controlAndStatus[MIP]!;
      const keep = orBytes(
        new Uint8Array(8),
        andBytes(new Uint8Array(8), mip, MIE_MIP_KEEP_OUTSIDE_SIE_SIP),
        andBytes(new Uint8Array(8), mip, MIP_HARDWARE_MASK_BYTES)
      );
      // Also preserve soft SEIP (writable only via mip, not sip).
      keep[1]! |= mip[1]! & MIP_BYTE1_SEIP;
      const incoming = andBytes(new Uint8Array(8), value, SIP_WRITABLE_MASK_BYTES);
      return copyBytes(
        registers.controlAndStatus[MIP]!,
        orBytes(new Uint8Array(8), keep, incoming)
      );
    }
    case MSTATUS:
      // Store mstatus after forcing MPP and UXL/SXL to legal encodings.
      return copyBytes(
        registers.controlAndStatus[MSTATUS]!,
        legalizeMstatus(copyBytes(new Uint8Array(8), value))
      );
    case MISA:
      // WARL: extensions/MXL are fixed for this hart; ignore the written value.
      return copyBytes(registers.controlAndStatus[MISA]!, MISA_HARDWIRED_BYTES);
    case MIE:
      return copyBytes(
        registers.controlAndStatus[MIE]!,
        andBytes(new Uint8Array(8), value, MIE_MASK_BYTES)
      );
    case MIP: {
      // Soft SEIP is writable; preserve device-driven MSIP/MTIP/MEIP. PLIC SEIP is not in the slot.
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
    case MCOUNTEREN:
    case SCOUNTEREN:
      return copyBytes(
        registers.controlAndStatus[index]!,
        andBytes(new Uint8Array(8), value, COUNTEREN_MASK_BYTES)
      );
    case MCOUNTINHIBIT:
      return copyBytes(
        registers.controlAndStatus[MCOUNTINHIBIT]!,
        andBytes(new Uint8Array(8), value, MCOUNTINHIBIT_MASK_BYTES)
      );
    case MEPC:
    case SEPC:
      return copyBytes(
        registers.controlAndStatus[index]!,
        legalizeXepc(copyBytes(new Uint8Array(8), value))
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

/** Set or clear the PLIC supervisor-external wire (not a guest CSR write). */
const setSupervisorExternalInterruptPending = (registers: Registers, pending: boolean): void => {
  registers.plicSupervisorExternalPending = pending;
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
  TWO_BYTES,
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
  beginInstructionRetire,
  cancelInstructionRetire,
  commitInstructionRetire,
  retireInstructionNow,
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
