# ya-risc-v

A RISC-V emulator written in TypeScript for Node (>= 24, ESM only). This is a **CLI program,
not a library** (`package.json` is `private`, only a `ya-risc-v` bin) — the `#emulator` /
`#tui` module roots are internal implementation details, never public API. See `README.md`
for commands, CLI options, project status, and the full file layout; this document covers the
invariants and conventions an agent must follow when changing code.

**Work in progress.** RV64I, RV64M, RV64A (LR/SC + AMOs), RV64C (compressed), Zicsr, U/S/M
privilege, traps, interrupts, CLINT, PLIC, UART, syscon, and PMP are implemented; further
extensions and virtual memory are still to come. Missing instructions and features are
unfinished work, not deliberate scope — don't treat the current opcode coverage in
`decode/` as the intended ceiling, and don't add code that assumes today's ISA is all there
will ever be.

## Commands

| Command                  | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `npm run dev -- <image>` | Run from source via `tsx` (`--ram-size` is required; extra flags need `--`) |
| `npm test`               | `node:test` runner over `src/**/*.test.ts` and `*.test.tsx`                 |
| `npm run check`          | format check + lint + type-check + tests (**run before done**)              |
| `npm run fix`            | Prettier write + `eslint --fix`                                             |
| `npm run build`          | Bundle to `dist/` (generated, gitignored — never edit by hand)              |

Optional pre-commit hooks (opt-in via `pre-commit`) run Prettier, `eslint --fix`, and `tsc`.

## Core invariants

These are ranked by how badly breaking them corrupts the emulator. Verify them against
`src/utils/bytes.ts`, `src/emulator/cpu/registers.ts`, and the instruction files before
assuming this summary is enough.

1. **Every architectural value is an 8-byte little-endian `Uint8Array`.** Registers, the PC,
   CSRs, and immediates never become `number` or `bigint`. Do arithmetic with the helpers in
   `#utils/bytes` (`addBytes`, `compareSignedBytes`, `shiftRightArithmeticBytes`, …).
   Mutating helpers take a caller-allocated `destination` buffer and return it for chaining
   (`addBytes(new Uint8Array(8), a, b)`) — passing a live register reference as the
   destination corrupts state; allocate a fresh buffer. `bytesToNumber` reads u32 from
   architectural bytes; `signedNumberToBytes`, `unsignedNumberToBytes`,
   `unsignedBigIntToBytes`, and `low32Bytes` pack values into a caller-allocated buffer.
2. **Decode returns a curried thunk: `(registers, memory, instructionByteLength) => void |
Promise<void>`.** Decode closes over instruction args — the thunk itself takes no args
   type. The thunk **owns the PC**: call `advanceProgramCounter(registers, instructionByteLength)`
   on the fall-through path, or `setProgramCounter` when jumping/branching (`jal`/`jalr` use
   the length for the link). The run loop never adjusts the PC itself and `await`s each
   instruction result (only `wfi` is async today — a new async instruction just returns a
   `Promise`). Decode memoizes thunks by instruction word in a bounded LRU cache, so thunks
   must be pure in what they close over. `instructionByteLength` is always required (no
   default) — unit tests pass `FOUR_BYTES` when calling instructions directly. Unused
   parameters are prefixed with `_`.
3. **Hardwired x0 drops writes in the register helpers.** Never write the register array
   directly; identity CSRs (`mvendorid`, `marchid`, `mimpid`, `mhartid`) are typed as
   `ReadonlyUint8Array` and the write helper also ignores stores to those slots. Read-only
   byte buffers elsewhere use the same structural `ReadonlyUint8Array` type (plain
   `Uint8Array` remains assignable); it is a hint, not a guard — don't mutate such values.
4. **Guest DRAM is a `SharedArrayBuffer` shared with the worker, accessed with plain byte
   reads and writes** — the absence of `Atomics` on ordinary guest loads/stores is deliberate.
   `guestAddress` means a guest physical address (architectural bytes); `hostIndex` means a
   `bigint` byte index into `memory.bytes`. Memory is a `regions` Map (`hostIndex` /
   `hostByteLength`, optional `guestAddress` / `guestByteLength`) packed contiguously with
   8-byte-aligned hostIndexes. `loadBytes`/`storeBytes` resolve a guestAddress to
   `{ regionId, offset }` and call the region's load/store pair; guest RAM/UART windows are
   dense, CLINT/PLIC are sparse MMIO over host slabs. Transfer widths are `number`.
   Aligned RV64A AMO/LR/SC use `Atomics` on `Int32`/`BigInt64` views; other host-only
   packing (UART queue meta, CLINT time/wires, PLIC shadows, irq-level / TX-wake words)
   uses `Atomics` on bytes, except `BigUint64Array` for CLINT time and `Int32Array` where
   `waitAsync`/`notify` is needed. Alignment and PMP are **not** checked in `memory.ts` —
   the instruction handlers and the fetch loop enforce them (see below).
5. **Guest-region IDs and pack order are a cross-file contract.** Region IDs and pack order
   are defined once in `src/emulator/index.ts` (`GUEST_REGION_IDS`: ram → uart → clint →
   plic → syscon → reservation → irqLevel, host-only regions last). The CLI defaults in
   `src/index.ts` and the test fixture `machineRegionSpecs` in `test/guest-memory.ts` must
   stay in sync with it, and any new guest-mapped device must also appear in the device
   tree (`src/fdt.ts`). Change all of them together.
6. **Reservation monitor invalidation.** A host-only LR/SC reservation monitor (per-hart
   slots, line granule) sits in the SAB after PLIC; `storeBytes` and atomic RMWs must
   invalidate overlapping reservations (`invalidateOverlappingReservationsLocked` /
   `withMonitorLock`). Never write guest RAM around this protocol.
7. **Host components are Promise-like awaitable handles with `start` / `stop`.** `Emulator`,
   `Cpu`, `Timer`, `Terminal`, and the TUI each implement a `Promise.withResolvers` lifetime
   with `then`/`catch`/`finally` plus idempotent `stop`. The pattern is: create → start →
   await; `stop` is safe before or after `start`, and awaiting joins the handle's lifetime.
   New host-side components should follow the same pattern. The CLI (`src/index.ts`) starts
   the TUI then the emulator, awaits the emulator, then stops and awaits the TUI; signal and
   syscon poweroff/reboot paths call `emulator.stop()`.
8. **Package boundaries are enforced by ESLint, not convention.** Import with `#` subpath
   specifiers and no file extension (`import { loadBytes } from '#emulator/memory'`);
   `tsconfig` `paths` maps `#*` to `src/*` and `#test/*` to `test/*`; relative imports are a
   lint error. A directory with `index.ts` is a package — sibling modules are private, and
   outside a directory you import only from the package root. Public subpaths: worker
   entries `#emulator/*/run`. Leaf modules (`#emulator/memory`, `#emulator/ram`,
   `#emulator/reservation`, `#emulator/wake`, `#emulator/irq-level`) are their own public
   API. Inside `emulator/`, packages import each other via roots only (hart samples CLINT
   via `#emulator/clint`, PLIC via `#emulator/plic`, irq via `#emulator/irq-level`; never
   `#emulator/timer` / `#emulator/terminal`). `eslint.config.mjs` is the authoritative
   statement of all of this — including the worker-bundle ban on `#emulator/timer`,
   `#emulator/terminal`, and `Worker` from `node:worker_threads` under every device package
   (`src/emulator/cpu/**`, `uart/**`, `clint/**`, `plic/**`, `syscon/**`, `timer/**`,
   `terminal/**` — worker files never spawn; only the three device hosts `cpu/index.ts`,
   `timer/index.ts`, and `terminal/index.ts` import `Worker`), which preserves tree-shaking
   (`sideEffects: false` — so also avoid top-level side effects in shared modules).

## Privileged architecture summary

The hart tracks U/S/M in `registers.privilegeMode` (reset = M). `ecall`, `ebreak`, and
illegal encodings call `enterTrap` in `trap.ts`: they write `xepc`/`xcause`/`xtval`, update
the enable stacks (`MPIE`/`MIE`/`MPP` or `SPIE`/`SIE`/`SPP`), delegate per `medeleg`
(`mideleg` for interrupt causes), and set the PC from `xtvec` in **Direct or Vectored
mode** (exceptions always use BASE). `mret`/`sret` restore the stack and return to `xepc`.
The run loop samples CLINT (`MSIP`/`MTIP`/`STIP`) and PLIC (`MEIP`/`SEIP`) wires into `mip`
before each fetch (`sampleDevicePending`), then calls `takeInterruptIfAny`. `wfi` advances
the PC, retires, and parks on the shared `irqLevel` word (via `Atomics.waitAsync`) until
`mip ∧ mie` is nonzero — wake ignores global `mstatus.MIE`/`SIE`; `mstatus.TW` makes
`wfi` below M illegal; `mstatus.TVM` gates S-mode `satp` access and `sfence.vma`.

CSR semantics live in `registers.ts` and `system.ts` and follow the spec closely (WARL
masks, read-only checks, access privilege). The actionable rules for an agent:

- Only the implemented CSR set is legal; anything else, or an access above the current
  privilege, raises illegal-instruction. Writes to read-only CSRs are illegal.
- `csrrs`/`csrrc` with `rs1 = x0` (and the zero-immediate forms) are read-only and may touch
  identity CSRs.
- CSR updates go through the byte-field helpers in `trap.ts`/`registers.ts` — never bit-
  twiddle a CSR slot with plain numbers.
- `sstatus`/`sie`/`sip` are masked aliases of `mstatus`/`mie`/`mip`; `time` mirrors CLINT
  `mtime`; `cycle`/`instret` alias `mcycle`/`minstret`.
- The Sstc `stimecmp` mirror and PMP entry lookup live in `registers.ts` / `pmp.ts`. PMP is
  checked at the instruction/fetch layer (`denyLoad`/`denyStore`/`denyAmo`, and the fetch
  loop in `run.ts`) — the lowest overlapping entry must cover the whole access; M ignores
  unlocked entries, S/U fault when nothing matches; `mstatus.MPRV` redirects loads/stores.
  Unmapped and straddling guest accesses fault at the same layer (loads 5, stores/AMOs 7,
  fetches 1) via the `guestAccessIsMapped` mapping query; `memory.ts` itself still performs
  **no** privilege or protection checks.

**Instruction retire is a protocol, not a side effect.** The run loop calls
`beginInstructionRetire` before execute and `commitInstructionRetire` after (unless
`mcountinhibit` freezes CY/IR); traps call `cancelInstructionRetire`, while
`ecall`/`ebreak`/`wfi` must `retireInstructionNow` before vectoring/parking. Preserve this
when touching the run loop, traps, or new system instructions, or `mcycle`/`minstret` drift.

## Adding instructions

1. Add or extend a file in `src/emulator/cpu/instructions/`, keeping the
   `/** mnemonic: rd = … */` doc comment. A new extension gets its own files under the
   same one-file-per-opcode-group convention. RVC expands in `decode/decode-c.ts` onto
   those same instruction functions; the multiplex passes `TWO_BYTES` so PC/link advance
   by halfword.
2. Wire 32-bit encodings in `decode/decode-32.ts` (opcode/funct3/funct7 constants with
   trailing comments; fall through to illegal). Wire RVC in `decode/decode-c.ts` by
   quadrant. Decode curries args into the thunk — the execute type in `decode/index.ts`
   stays `(registers, memory, instructionByteLength)`.
3. Add a colocated `*.test.ts` covering the value written _and_ the resulting PC (see
   Testing).

## Style

Enforced by ESLint and Prettier (single quotes, semicolons, 100 columns, 2-space indent):

- **Arrow functions only** — no `function` expressions or declarations, and no
  `export default function`.
- Modules with a single export use `export default`; otherwise list named exports in one
  block at the bottom of the file, with `export type { … }` after it.
- **Export only what production code needs.** Do not export helpers, types, or constants
  solely so tests can import them (tests may deep-import private modules, or share fixtures
  via `test/`). No unused exports.
- No `any`, no `==`, no `@ts-` comments. Any `eslint-disable` needs a `-- reason`.
- **Type safety is strict beyond `no-any`:** `@typescript-eslint/no-unsafe-*` (assignment,
  member access, call, return, argument), `no-floating-promises`, `await-thenable`,
  `no-misused-promises`, `require-await`, and `no-unnecessary-type-assertion` are all
  errors. Promises must be awaited or handled (the documented fire-and-forget exceptions
  are explicit); avoid assertions — loose types cascade into lint failures.
- Bitwise operators and typed-array indexing are expected here; those rules are off on
  purpose.
- Every file in `src/` opens with the Apache 2.0 header (in `index.ts` it follows the
  shebang). Copy it verbatim into new files, ahead of any `eslint-disable` block.

## Testing

`node:test` with `describe`/`it` and `node:assert/strict`. Start each test from
`createRegisters()` / `createTestMemory(256n)` (`#test/guest-memory` — it builds the full
standard machine layout, including host-only regions; don't hand-roll custom region
wiring). Pass `FOUR_BYTES` when calling instructions directly. Compare register state with
`assert.deepEqual(readGeneralPurposeRegister(registers, 1), signedNumberToBytes(10, 32))`
rather than hand-written byte arrays. Unit tests stay colocated as `*.test.ts`; helpers
live in `test/`, not `src/`. Tests may deep-import `#emulator/cpu/*` helpers but must use
other packages' roots (`#emulator/uart/*` etc. are lint-banned deep imports).

### Writing valuable tests

A test earns its place by pinning an outcome a plausible bug would break — an exact
register/CSR value, PC, trap cause/`mtval`, WARL mask, memory canary, or device wire
level — not by executing lines. Before adding a test, name the bug class it is the only
guard against; if that class is already pinned elsewhere (or belongs to an integration
boundary), don't add it. Avoid: store→load round-trips through the same helpers as their
own oracle, near-duplicate variants that add no new behavior dimension, and single-block
files whose only assertion would pass under a broken implementation. Merging variants is
preferred over deleting when every assertion can survive the merge.

### Integration tests (`*.integration.test.ts`)

Unit tests exercise one unit; when behavior only exists across components — fetch loop,
worker pumps, interrupt wake, poweroff — write an integration test that instantiates the
real `Emulator` (`create` from `#emulator`) and runs it. No mocks: pass real `PassThrough`
streams, real `guestRegions`, and a real `image`. Rules:

- **Images are TypeScript `Uint8Array` literals in the test file**, never fixture files.
  Formatting: one instruction per line (2 bytes for RVC, 4 otherwise), trailing
  `// mnemonic operands — intent` comment; **never pad instructions to 64-bit lanes** —
  the PC advances by instruction length and the next fetch must land on an instruction,
  not on `0x00000000` (illegal-instruction trap; with `mtvec` = 0 the hart loops forever).
  Data sections are 64-bit-aligned rows of exactly 8 bytes with comments; alignment
  padding only at instruction→data boundaries, commented as alignment.
- **Protect the layout from formatters**: put `// prettier-ignore` immediately above each
  image literal, and re-read the file after `npm run fix` to confirm it survived.
- **Verify encodings before trusting them**: probe each emitted word through `decode`
  (`#emulator/cpu/decode`) against `createTestMemory` before running the suite. A probe
  that calls `decode` directly does NOT prove the image runs — it skips fetch sequencing;
  the integration run is the arbiter.
- **Termination must be deterministic, never wall-clock**: guest-side, gate poweroff on
  UART `LSR.TEMT`/`THRE` (TX drained) before storing the syscon poweroff value. The
  host stops the CPU worker in response to the syscon request; the power-cut window is
  nondeterministic like real silicon, so guests must be yank-safe — after the finisher
  store, spin (`jal x0, 0`) or `wfi` and do no observable work. The terminal drains on
  stop, so a TEMT-gated poweroff loses no output — but a print issued at the exact
  poweroff store still depends on that gate. Host-side, every wait is bounded:
  `it(..., { timeout })`, a `Promise.race` deadline around `await emulator`, bounded
  stdout polling; teardown (`emulator.stop()` + awaited settle) in `finally`. Prove
  non-flakiness with repeated runs.
