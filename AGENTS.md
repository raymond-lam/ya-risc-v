# ya-risc-v

A RISC-V emulator written in TypeScript for Node (>= 24, ESM only). The CLI (`src/index.ts`)
reads a raw program image, starts the emulator and Ink TUI, and wires them over streams.

**Work in progress.** RV64I, RV64M, RV64A (LR/SC + AMOs), Zicsr, U/S/M privilege (`mret`/`sret`,
`medeleg`/`mideleg`, S-mode trap CSRs), synchronous traps (`ecall`/`ebreak`/illegal →
`mtvec`/`stvec`), interrupt delivery (`mie`/`mip`/`sie`/`sip`, run-loop take, `wfi`), a CLINT
(`msip` → `mip.MSIP`, `mtime`/`mtimecmp` → `mip.MTIP`), and a PLIC (priority/enable/claim →
`mip.MEIP`/`SEIP`, UART source 10) are implemented; further extensions and virtual memory are
still to come.
Missing instructions and features are unfinished work, not deliberate scope — don't treat the
current opcode coverage in `decode.ts` as the intended ceiling, and don't add code that assumes
today's ISA is all there will ever be.

## Commands

| Command               | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `npm run dev <image>` | Run from source via `tsx` (pass `--ram-size`)                  |
| `npm test`            | `node:test` runner over `src/**/*.test.ts` and `*.test.tsx`    |
| `npm run check`       | format check + lint + type-check + tests (run before done)     |
| `npm run fix`         | Prettier write + `eslint --fix`                                |
| `npm run build`       | Bundle to `dist/` (generated, gitignored — never edit by hand) |

Worker bundles are tree-shaken (`sideEffects: false`, esbuild `--tree-shaking`): the hart worker may
import CLINT wire samples from `#emulator/clint` (device API) without keeping the timebase
`create` / `Worker` path (`#emulator/timer` stays out of the hart graph). ESLint bans
`#emulator/timer`, `#emulator/terminal`, and `Worker` from `node:worker_threads` under
`src/emulator/cpu/**` (except host `cpu/index.ts`).

Pre-commit hooks run Prettier, `eslint --fix`, and `tsc` on `src/`.

## Layout

- `src/index.ts` — Commander CLI; loads the image, `create`s the emulator and TUI, starts the TUI
  then the emulator (`onShutdown` / signals call `emulator.stop()`), awaits the emulator, then
  stops and awaits the TUI.
- `src/tui/` — host Ink UI (`create` / `start` / `stop`; `components/`, `hooks/use-mouse-left-click`);
  terminal pane over caller streams.
- `src/emulator/index.ts` — host-side `create` (requires `ramSize`); maps the image into DRAM at
  `0x8000_0000` (UART at `0x1000_0000`, CLINT at `0x0200_0000`, PLIC at `0x0c00_0000`), creates
  CPU + timer + terminal handles, returns an awaitable. `start` / `stop` forward to all three;
  awaiting joins all three.
- `src/emulator/cpu/` — CPU package: host `create` / `start` / `stop`, worker `run.ts`, decode,
  trap, registers, instructions (one file per opcode group).
- `src/emulator/memory.ts` — guest memory leaf: `createMemory(regionSpecs)`, load/store
  dispatch, `Memory` type. Packs caller-supplied regions into one SAB; does not own
  device init or layout.
- `src/emulator/ram.ts` — RAM region: dense guest load/store, `storeImageToRam`, RV64A RMW.
- `src/emulator/plic.ts` — PLIC sparse MMIO, claim/complete, MEIP/SEIP wires.
- `src/emulator/reservation.ts` — host-only LR/SC reservation monitor.
- `src/emulator/wake.ts` — Int32 wake/level publish + `waitWake` (IRQ aggregate, UART TX).
- `src/emulator/irq-level.ts` — host-only Int32 OR of device IRQ levels (`setIrqWire`,
  `waitIrqLevel`); packed as the `irqLevel` region.
- `src/emulator/clint/` — device API (`index`: MMIO / init / `tickClint` / wire samples); private
  `layout` / `memory` / `wires` / `time`.
- `src/emulator/timer/` — CLINT timebase host `create` / `start` / `stop`, worker `run.ts`
  (ticks `mtime` via `#emulator/clint`).
- `src/emulator/uart/` — UART 16550 package (`index` public API; private `region` / `queues` /
  `registers` / `memory`). Terminal uses RX/TX via `#emulator/uart`.
- `src/emulator/terminal/` — UART↔stream bridge: host `create` / `start` / `stop`, worker
  `run.ts` (async TX pump awaits `waitUartTransmit`; stdin pushes RX).
- `src/utils/bytes.ts` — architectural byte helpers.
- `src/utils/int.ts` — `bigIntAsNumber` (safe `bigint` → JS `number`).
- `src/utils/alignment.ts` — `alignUp` (power-of-two round-up for `bigint`).
- `src/utils/atomics.ts` — SAB byte/bit Atomics helpers (`atomicLoadBit`, …).
- `src/utils/binary-search.ts` — `findLastIndex` (MDN-shaped; O(log n) on a true…false partition).
- `src/types.ts` — shared architectural types (`ReadonlyUint8Array`).
- `test/` — shared test helpers (`guest-memory.ts`). Unit tests stay colocated as `*.test.ts`.

## Core invariants

- **Every architectural value is an 8-byte little-endian `Uint8Array`.** Registers, the PC, CSRs,
  and immediates never become `number` or `bigint`. Do arithmetic with the helpers in
  `#utils/bytes` (`addBytes`, `compareSignedBytes`, `isZeroBytes`, `shiftRightArithmeticBytes`,
  …), including CSR bitfield updates in `trap.ts`. Mutating helpers take a `destination`
  buffer and return it for chaining (`const x = addBytes(new Uint8Array(8), a, b)`).
  **guestAddress** means a guest physical address (architectural bytes); **hostIndex** means a
  `bigint` byte index into the SAB (`memory.bytes`). Memory is carved into a **regions** Map
  (`hostIndex` / `hostByteLength`, optional `guestAddress` / `guestByteLength`); regions are
  packed contiguously with 8-byte-aligned hostIndexes. `loadBytes`/`storeBytes` map a
  guestAddress to `{ regionId, offset }` then call the region's load/store pair — UART queues, IRQ wires, the LR/SC
  monitor, and wake words are host-only (`bigIntAsNumber` at the TypedArray boundary). Guest-mapped RAM
  size is `bigint` (also the RAM region's host length). UART guest window is 8 register bytes
  (dense prefix of the UART region); RBR/THR/IER/IIR/LSR have queue/IRQ side effects
  (`uart/registers.ts` — IER∧(RX ready / TX empty) asserts PLIC source 10). CLINT/PLIC are
  sparse guest windows over packed host slabs (`clint/layout.ts` + `clint/memory.ts` / `plic.ts`); the hart
  samples CLINT wires into `mip.MTIP`/`MSIP` and PLIC wires into `mip.MEIP`/`SEIP`. Transfer
  widths (`byteLength` on load/store) are `number`. `bytesToNumber` reads u32 from
  architectural bytes. `signedNumberToBytes`, `unsignedNumberToBytes`, `unsignedBigIntToBytes`,
  and `low32Bytes` pack values into a caller-allocated buffer (same destination/return
  convention).
- **Instruction functions are `(registers, memory, args) => void | Promise<void>`** and own the
  PC: call `advanceProgramCounter` on the fall-through path, or `setProgramCounter` when
  jumping/branching. The CPU worker `await`s each instruction (only `wfi` is async today).
  Unused parameters are prefixed with `_`. Args go in a named type (`OpArgs`, `LoadArgs`) exported
  alongside the instructions; `decode.ts` extracts fields and closes over them in the thunk.
- **Hardwired x0 drops writes in the register helpers.** Identity CSRs
  (`mvendorid`, `marchid`, `mimpid`, `mhartid`) are typed as `ReadonlyUint8Array`; the write
  helper still ignores stores to those slots as a safety net. Guest CSR instructions must not
  reach that path for illegal cases (see Zicsr). Read-only byte buffers elsewhere (addresses,
  immediates, arithmetic sources) use the same structural `ReadonlyUint8Array` type so plain
  `Uint8Array` remains assignable.
- **Guest DRAM is a `SharedArrayBuffer`** shared with the worker, accessed with plain byte reads
  and writes. The absence of `Atomics` on ordinary loads/stores is deliberate: unsynchronized hosts
  should race like real memory. Aligned RV64A AMO/LR/SC on RAM use `Atomics` on `Int32` /
  `BigInt64` views; a host-only LR/SC reservation monitor (per-hart slots, line granule) sits in
  the SAB after PLIC and is invalidated by overlapping `storeBytes` / atomic AMO writes. Other
  host-only packing
  (UART queue meta, CLINT time/epoch/wires, PLIC shadows/wires) uses `Atomics` on bytes
  (`Uint8Array`), except CLINT time/epoch (`BigUint64Array`) and the irq-level / UART TX-wake words
  (`Int32Array` for `Atomics.waitAsync` / `notify`).
- **Privilege modes and traps.** The hart tracks U/S/M in `registers.privilegeMode`
  (8-byte little-endian; reset = M). `ecall`, `ebreak`, and illegal encodings call `enterTrap` in
  `trap.ts`: they write `xepc`/`xcause`/`xtval`, update enable stacks (`MPIE`/`MIE`/`MPP` or
  `SPIE`/`SIE`/`SPP`), set privilege to M or S (when `medeleg` delegates and the hart is below M),
  and set the PC from `mtvec`/`stvec` (direct mode). `mret`/`sret` restore that stack and return to
  `mepc`/`sepc`. `ecall` cause is 8/9/11 by mode. The CLINT worker ticks `mtime` and drives a
  level-sensitive timer wire in the SAB; guest `msip` stores drive a software IRQ wire. The hart
  run loop samples both wires into `mip.MTIP` / `mip.MSIP`, then calls
  `takeInterruptIfAny` before each fetch: pending∧enabled interrupts take via the
  same entry path with `xcause` interrupt bit set; `mideleg` routes supervisor causes to S.
  `wfi` advances the PC then waits on the shared irq-level Int32 (published OR of device
  IRQ levels; `Atomics.waitAsync` until the level word changes) until
  `mip ∧ mie` is nonzero (wake ignores global
  `mstatus.MIE`/`SIE`). With `mstatus.TW` set, `wfi` below M raises illegal-instruction
  immediately (limit = 0). With `mstatus.TVM` set, S-mode access to `satp` raises
  illegal-instruction (M still allowed).
  `mip.MSIP`/`MTIP` (CLINT) and `mip.MEIP`/`SEIP` (PLIC) are not CSR-writable; other pending
  bits remain software-writable until more devices exist.
- **Zicsr checks CSR existence and privilege.** `csrrw`/`csrrs`/`csrrc` and the immediate forms live
  in `system.ts` (SYSTEM opcode group). Only the implemented set is accessible (`mstatus`/
  `sstatus`, `misa`, `medeleg`/`mideleg`, `mie`/`mip`, `sie`/`sip`, `mtvec`/`stvec`, `mscratch`/
  `sscratch`, `mepc`/`sepc`, `mcause`/`scause`, `mtval`/`stval`, `satp`, `cycle`/`time`/`instret`,
  `mcycle`/`minstret`, `mcounteren`/`scounteren`, `mcountinhibit`, and the identity CSRs); any other
  index or an access above the current privilege raises illegal-instruction. Writes to read-only
  CSRs also illegal; `csrrs`/`csrrc` with `rs1` = `x0` and `csrrsi`/`csrrci` with a zero immediate
  are read-only and may touch identity CSRs. `sstatus`/`sie`/`sip` are masked aliases of
  `mstatus`/`mie`/`mip`; `misa` is hardwired WARL (RV64IMA + S/U); `mstatus` MPP is WARL
  (reserved → U); `mie`/`mideleg` WARL to implemented interrupt bits; `mip` WARL preserves
  hardware `MSIP`/`MTIP`/`SEIP`/`MEIP`. `time` mirrors CLINT `mtime`; `cycle`/`instret` alias
  `mcycle`/`minstret` and advance together on retire (CPI=1) unless `mcountinhibit` freezes CY/IR;
  traps cancel retire except `ecall`/`ebreak`. `mcounteren`/`scounteren` WARL to CY/TM/IR and gate
  S/U (U needs both). `satp` is stored but does not enable paging yet; with `mstatus.TVM` set,
  S-mode `satp` access is illegal. They snapshot the CSR slot before writing `rd` (the file is live).

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
  entries `#emulator/cpu/run`, `#emulator/timer/run`, and `#emulator/terminal/run` are also
  `package.json` `"imports"` targets (`src` vs `dist`). Relative imports are a lint error.
- **Package boundary:** a directory with `index.ts` is a package. Sibling modules
  (`cpu/types.ts`, …) are private; outside that directory import only from the package root.
  Public subpaths: worker entries `#emulator/*/run`. Leaf modules (`#emulator/memory`,
  `#emulator/ram`, `#emulator/plic`, `#emulator/reservation`, `#emulator/wake`,
  `#emulator/irq-level`) are their own public API. Host code uses `#emulator` and `#tui`.
  Inside `emulator/`, packages import each other via roots (hart samples CLINT via
  `#emulator/clint`, PLIC via `#emulator/plic`, irq via `#emulator/irq-level`; never
  `#emulator/timer` / `#emulator/terminal`). Unit and `*.integration.test.ts` files may
  deep-import cpu instruction / register / trap modules for coverage.
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
