# ya-risc-v

A RISC-V emulator written in TypeScript for Node (>= 24, ESM only). The CLI (`src/index.ts`)
reads a raw program image, starts the emulator and Ink TUI, and wires them over streams.

**Work in progress.** RV64I, RV64M, Zicsr, and M-mode synchronous traps (`ecall`/`ebreak`/illegal →
`mtvec`, plus `mret`) are implemented; further extensions and privilege levels are still to come.
Missing instructions and features are unfinished work, not deliberate scope — don't treat the
current opcode coverage in `decode.ts` as the intended ceiling, and don't add code that assumes
today's ISA is all there will ever be.

## Commands

| Command               | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `npm run dev <image>` | Run from source via `tsx` (pass `--ram-size`)                |
| `npm test`            | `node:test` runner over `src/**/*.test.ts` and `*.test.tsx`  |
| `npm run check`       | format check + lint + type-check + tests (run before done)   |
| `npm run fix`         | Prettier write + `eslint --fix`                              |
| `npm run build`       | Bundle to `dist/` (generated, gitignored — never edit by hand) |

Pre-commit hooks run Prettier, `eslint --fix`, and `tsc` on `src/`.

## Layout

- `src/index.ts` — Commander CLI; loads the image, `create`s the emulator and TUI, starts the TUI
  then the emulator (`onShutdown` / signals call `emulator.stop()`), awaits the emulator, then
  stops and awaits the TUI.
- `src/tui/` — host Ink UI (`create` / `start` / `stop`; `components/`, `hooks/use-mouse-left-click`);
  terminal pane over caller streams.
- `src/emulator/index.ts` — host-side `create` (requires `ramSize`); maps the image into DRAM at
  `0x8000_0000` (UART at `0x1000_0000`), creates CPU + terminal handles, returns an awaitable.
  `start` / `stop` forward to both; awaiting joins both.
- `src/emulator/cpu/` — CPU package: host `create` / `start` / `stop`, worker `run.ts`, decode,
  trap, registers, instructions (one file per opcode group).
- `src/emulator/memory/` — guest memory package (`index` public API; private `types` / `ram` /
  `uart`).
- `src/emulator/terminal/` — UART↔stream bridge: host `create` / `start` / `stop`, worker `run.ts`.
- `src/utils/bytes.ts` — architectural byte helpers (`ReadonlyUint8Array` lives here, re-exported
  from `#emulator/memory` with `Memory`).
- `test/` — shared test helpers (`guest-memory.ts`). Unit tests stay colocated as `*.test.ts`.

## Core invariants

- **Every architectural value is an 8-byte little-endian `Uint8Array`.** Registers, the PC, CSRs,
  and immediates never become `number` or `bigint`. Do arithmetic with the helpers in
  `#utils/bytes` (`addBytes`, `compareSignedBytes`, `isZeroBytes`, `shiftRightArithmeticBytes`,
  …), including CSR bitfield updates in `trap.ts`. Mutating helpers take a `destination`
  buffer and return it for chaining (`const x = addBytes(new Uint8Array(8), a, b)`). Guest
  addresses stay as byte arrays through `loadBytes`/`storeBytes`. Map decode
  uses `bytesToBigInt` only for range compares. Guest-mapped RAM size (`ramSize`) is `bigint`
  (PA math); the UART window is a fixed 16550 register block (8 bytes) with RX/TX queues
  packed in the SAB (host-only; RBR/THR/LSR loads/stores are queue side effects in
  `memory/uart.ts`). **address** means a guest physical address (architectural bytes);
  **index** means a host TypedArray index into `memory.bytes` (`number`). Transfer widths
  (`byteLength` on load/store) are also `number`.
  `bytesToNumber` reads u32 from architectural bytes. `signedNumberToBytes`,
  `unsignedNumberToBytes`, `unsignedBigIntToBytes`, and `low32Bytes` pack values into a
  caller-allocated buffer (same destination/return convention).
- **Instruction functions are `(registers, memory, args) => void`** and own the PC: call
  `advanceProgramCounter` on the fall-through path, or `setProgramCounter` when jumping/branching.
  Unused parameters are prefixed with `_`. Args go in a named type (`OpArgs`, `LoadArgs`) exported
  alongside the instructions; `decode.ts` extracts fields and closes over them in the thunk.
- **Hardwired x0 drops writes in the register helpers.** Identity CSRs
  (`mvendorid`, `marchid`, `mimpid`, `mhartid`) are typed as `ReadonlyUint8Array`; the write
  helper still ignores stores to those slots as a safety net. Guest CSR instructions must not
  reach that path for illegal cases (see Zicsr). Read-only byte buffers elsewhere (addresses,
  immediates, arithmetic sources) use the same structural `ReadonlyUint8Array` type so plain
  `Uint8Array` remains assignable.
- **Guest memory is a `SharedArrayBuffer`** shared with the worker, accessed with plain byte reads
  and writes. The absence of `Atomics` is deliberate: unsynchronized hosts should race like real
  memory.
- **M-mode synchronous traps.** `ecall`, `ebreak`, and illegal encodings call `enterTrap` in
  `trap.ts`: they write `mepc`/`mcause`/`mtval`, update `mstatus` (MPIE←MIE, MIE←0, MPP←M), and
  set the PC from `mtvec` (direct mode). `mret` restores that stack and returns to `mepc`. No
  U/S modes or interrupts yet.
- **Zicsr checks CSR existence.** `csrrw`/`csrrs`/`csrrc` and the immediate forms live in
  `system.ts` (SYSTEM opcode group). Only the implemented set is accessible (`mstatus`, `mtvec`,
  `mepc`, `mcause`, `mtval`, and the identity CSRs); any other index raises illegal-instruction.
  Writes to read-only CSRs also illegal; `csrrs`/`csrrc` with `rs1` = `x0` and `csrrsi`/`csrrci`
  with a zero immediate are read-only and may touch identity CSRs. They snapshot the CSR slot
  before writing `rd` (the file is live). Do not add privilege checks or WARL masks until
  multi-mode support exists.

## Adding instructions

1. Add or extend a file in `src/emulator/cpu/instructions/`, keeping the `/** mnemonic: rd = … */`
   doc comment. A new extension gets its own files under the same one-file-per-opcode-group
   convention.
2. Add the opcode/funct3/funct7 constants to `decode.ts` (with a trailing comment) and wire the case,
   falling through to `illegalInstruction` for unmatched encodings.
3. Add a colocated `*.test.ts` covering the value written _and_ the resulting PC.

## Style

Enforced by ESLint and Prettier (single quotes, semicolons, 100 columns, 2-space indent):

- Import with `#` subpath specifiers and no file extension
  (`import { loadBytes } from '#emulator/memory'`). `tsconfig` `paths` maps `#*` to `src/*` and
  `#test/*` to `test/*`; bundler resolution fills in `index` and `.ts`/`.tsx`. The worker
  entries `#emulator/cpu/run` and `#emulator/terminal/run` are also `package.json` `"imports"`
  targets (`src` vs `dist`). Relative imports are a lint error.
- **Package boundary:** a directory with `index.ts` is a package. Sibling modules
  (`memory/uart.ts`, `cpu/types.ts`, …) are private; outside that directory import only from the
  package root. Host code uses `#emulator` and `#tui`. Inside `emulator/`, subpackages import each
  other via `#emulator/cpu`, `#emulator/memory`, `#emulator/terminal` (workers use
  `#emulator/cpu/run` / `#emulator/terminal/run`). Unit tests may import instruction modules
  directly for coverage.
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
hand-written byte arrays, and start from `createRegisters()` / `createTestMemory(256n)`
  (`#test/guest-memory`) in each test. Helpers live in `test/`, not `src/`.
