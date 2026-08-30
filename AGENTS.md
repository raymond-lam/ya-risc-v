# ya-risc-v

A RISC-V emulator written in TypeScript for Node (>= 24, ESM only). The CLI (`src/index.ts`)
reads a raw program image, maps it into shared guest memory, and runs the CPU in a worker thread.

**Work in progress.** RV64I and Zicsr are implemented; further extensions and privileged/trap
support are still to come. Missing instructions and features are unfinished work, not deliberate
scope — don't treat the current opcode coverage in `decode.ts` as the intended ceiling, and don't
add code that assumes today's ISA is all there will ever be.

## Commands

| Command               | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `npm run dev <image>` | Run from source via `tsx`                                    |
| `npm test`            | `node:test` runner over `src/**/*.test.ts`                   |
| `npm run check`       | format check + lint + type-check + tests (run before done)   |
| `npm run fix`         | Prettier write + `eslint --fix`                              |
| `npm run build`       | Emit to `dist/` (generated, gitignored — never edit by hand) |

Pre-commit hooks run Prettier, `eslint --fix`, and `tsc` on `src/`.

## Layout

- `src/index.ts` — Commander CLI; creates memory, calls `run`, wires SIGINT/SIGTERM to `terminate`.
- `src/cpu/index.ts` — host-side `run`, spawns the worker and returns an awaitable handle.
- `src/cpu/run.ts` — worker entry; the fetch/decode/execute loop.
- `src/cpu/decode.ts` — opcode/funct switch; returns an execute thunk, memoized by instruction word.
- `src/cpu/instructions/` — one file per opcode group, named after the RISC-V opcode (`op-imm-32.ts`).
- `src/cpu/registers.ts`, `src/memory.ts`, `src/utils/bytes.ts` — architectural state and byte helpers.

## Core invariants

- **Every architectural value is an 8-byte little-endian `Uint8Array`.** Registers, the PC, CSRs,
  and immediates never become `number` or `bigint`. Do arithmetic with the helpers in
  `#utils/bytes.js` (`addBytes`, `compareSignedBytes`, `isZeroBytes`, `shiftRightArithmeticBytes`,
  …), not by converting to JS numbers. `bytesToNumber` exists for addresses and instruction words
  only, and reads just the low 32 bits.
- **Instruction functions are `(registers, memory, args) => void`** and own the PC: call
  `advanceProgramCounter` on the fall-through path, or `setProgramCounter` when jumping/branching.
  Unused parameters are prefixed with `_`. Args go in a named type (`OpArgs`, `LoadArgs`) exported
  alongside the instructions; `decode.ts` extracts fields and closes over them in the thunk.
- **`ReadonlyUint8Array` enforces hardwired registers** — x0 and the identity CSRs (`mvendorid`,
  `marchid`, `mimpid`, `mhartid`) silently drop writes. Keep those slots readonly.
- **Guest memory is a `SharedArrayBuffer`** shared with the worker, accessed with plain byte reads
  and writes. The absence of `Atomics` is deliberate: unsynchronized hosts should race like real
  memory.
- Traps aren't implemented yet. For now `ecall`/`ebreak` and illegal instructions throw, which kills
  the worker and rejects the run handle. Treat that as a placeholder for real trap handling.
- **Zicsr is raw CSR access.** `csrrw`/`csrrs`/`csrrc` and the immediate forms live in
  `system.ts` (SYSTEM opcode group). They snapshot the CSR slot before writing `rd` (the file is
  live). `csrrs`/`csrrc` omit the write when `rs1` is `x0`; `csrrsi`/`csrrci` omit it when the
  immediate is zero. Do not add privilege checks or WARL masks until trap/mode support exists;
  identity CSRs stay read-only via `ReadonlyUint8Array`.

## Adding instructions

1. Add or extend a file in `src/cpu/instructions/`, keeping the `/** mnemonic: rd = … */` doc comment.
   A new extension gets its own files under the same one-file-per-opcode-group convention.
2. Add the opcode/funct3/funct7 constants to `decode.ts` (with a trailing comment) and wire the case,
   falling through to `illegalInstruction` for unmatched encodings.
3. Add a colocated `*.test.ts` covering the value written _and_ the resulting PC.

## Style

Enforced by ESLint and Prettier (single quotes, semicolons, 100 columns, 2-space indent):

- Import with `#` subpath specifiers and a `.js` extension (`import { loadBytes } from '#memory.js'`).
  Relative imports are a lint error. The `@ya-risc-v/source` condition maps `#*` to `src/*`.
- Arrow functions only — no `function` expressions or declarations, and no `export default function`.
- Modules with a single export use `export default`; otherwise list named exports in one block at the
  bottom of the file, with `export type { … }` after it.
- No `any`, no `==`, no `@ts-` comments. Any `eslint-disable` needs a `-- reason` explanation.
- Bitwise operators and typed-array indexing are expected here; those rules are off on purpose.
- Every file in `src/` opens with the Apache 2.0 header (in `index.ts` it follows the shebang). Copy
  it verbatim into new files, ahead of any `eslint-disable` block.

## Testing

`node:test` with `describe`/`it` and `node:assert/strict`. Compare register state with
`assert.deepEqual(readGeneralPurposeRegister(registers, 1), signedNumberToBytes(10, 32))` rather than
hand-written byte arrays, and start from `createRegisters()` / `createMemory(256)` in each test.
