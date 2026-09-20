# ya-risc-v

Yet another RISC-V emulator, written from scratch in TypeScript for Node.

> [!WARNING]
> **This is a work in progress and nowhere near finished.** RV64I, RV64M, and Zicsr execute and are
> covered by tests. U/S/M privilege modes, `mret`/`sret`, trap CSRs, synchronous traps, interrupt
> delivery, and a CLINT (`msip` → `mip.MSIP`, `mtime`/`mtimecmp` → `mip.MTIP`) are in
> place. A polled 16550
> UART plus an Ink TUI console path exist, but there is no PLIC, no further ISA extensions, and no
> OS boot path. It cannot run Linux yet. Anything listed under
> [Not yet implemented](#not-yet-implemented) is unfinished work rather than a deliberate limit on
> scope — the goal is a much more complete machine than what is here today.

## Status

### Working today

- The full **RV64I** base integer instruction set: `lui`, `auipc`, `jal`, `jalr`, the six branches,
  all seven loads, all four stores, the register–immediate and register–register integer ops, and
  the RV64-specific 32-bit forms (`addiw`, `sllw`, `sraw`, …).
- **RV64M** multiply/divide: `mul`/`mulh`/`mulhsu`/`mulhu`, `div`/`divu`, `rem`/`remu`, and the
  32-bit forms `mulw`, `divw`/`divuw`, `remw`/`remuw` (including the ÷0 and signed-overflow cases).
- **Zicsr:** `csrrw`, `csrrs`, `csrrc`, and the immediate forms `csrrwi`, `csrrsi`, `csrrci`.
  Only implemented CSRs are accessible (`mstatus`/`sstatus`, `medeleg`/`mideleg`, `mie`/`mip`,
  `sie`/`sip`, `mtvec`/`stvec`, `mepc`/`sepc`, `mcause`/`scause`, `mtval`/`stval`, identity);
  other indices, insufficient privilege, and writes to read-only CSRs raise illegal-instruction.
  `csrrs`/`csrrc` skip the write when the source is zero. `sstatus`/`sie`/`sip` are masked views
  of `mstatus`/`mie`/`mip`. WARL: MPP legalization; `mie`/`mideleg` to implemented IRQ bits;
  `mip` preserves hardware `MSIP`/`MTIP`.
- **Privilege modes:** the hart tracks U/S/M (reset = M). Traps record `MPP`/`SPP`, switch mode,
  and vector through `mtvec` or `stvec` when `medeleg`/`mideleg` delegates. `mret`/`sret` restore
  the previous mode; `ecall` uses causes 8/9/11 by mode. `mret` is M-only; `sret` is illegal in U.
- **Synchronous traps:** `ecall`, `ebreak`, and illegal encodings write `xepc` / `xcause` /
  `xtval`, update status enable stacks, and jump to the chosen `xtvec` (direct mode).
- **Interrupts:** the CLINT tick worker advances `mtime` and drives a timer IRQ wire; guest `msip`
  stores drive a software IRQ wire; the CPU run loop samples both into `mip.MTIP` / `mip.MSIP`,
  then calls `takeInterruptIfAny` before each fetch. Pending∧enabled local interrupts vector with
  the `xcause` interrupt bit set; global `MIE`/`SIE` and privilege rules apply; `mideleg` sends
  supervisor causes to S. `mip.MSIP` and `mip.MTIP` are CLINT-driven (not CSR-writable).
- **CLINT:** MMIO at `0x02000000` — `msip` at `+0x0000` (bit 0), `mtimecmp` at
  `+0x4000`, `mtime` at `+0xbff8`, 10 MHz timebase from `process.hrtime` on its own worker. Reset:
  `mtime` = 0, `mtimecmp` = all-ones, `msip` clear. Guest may write `mtime` (reseats the epoch) or
  `mtimecmp` to arm/clear the timer; write `msip` bit 0 to assert/clear the software interrupt.
- `fence`, decoded and executed as a no-op, which is architecturally legal for this emulator.
- Integer registers x0–x31, the program counter, and a dense 4096-entry CSR file backing the
  implemented set, with x0 and the identity CSRs (`mvendorid`, `marchid`, `mimpid`, `mhartid`)
  hardwired read-only.
- A fetch/decode/execute loop running on a worker thread against shared guest memory, with decoded
  instructions memoized by their 32-bit encoding.
- **Guest memory map:** DRAM at `0x80000000` (size set by the caller / `--ram-size`), a fixed
  8-byte **16550 UART** window at `0x10000000` (RBR/THR queues and LSR DR/THRE/TEMT), and a
  **CLINT** at `0x02000000` (`msip` / `mtimecmp` / `mtime`). Flat images are copied to the RAM base (reset
  PC matches). Guest I/O is polled; there is no UART interrupt line yet.
- **Host console:** a terminal worker bridges UART RX/TX to streams, and an Ink TUI paints guest
  output with a headless VT100 emulator (`@xterm/headless`), with click-to-focus and Shutdown.
- Unit tests over the decoder, instructions, traps, registers, memory (including UART queues and
  CLINT), the CLINT and terminal workers, byte helpers, and VT100 encoding/viewport helpers.

### Not yet implemented

- **External IRQs.** Interrupt CSRs, run-loop delivery, and the CLINT timer exist, but there is no
  PLIC or UART IRQ line. Other standard CSRs are not implemented (access raises illegal-instruction).
- **Extensions.** No A (atomics), F/D (floating point), or C (compressed).
- **Virtual memory.** No paging (`satp` / Sv39).
- **Alignment and bounds checks.** Misaligned accesses are not faulted, and out-of-range loads read
  as zero instead of trapping.
- **Program loading.** Images are flat binaries copied to the RAM base (`0x80000000`); there is no
  ELF loader, DTB, or multi-payload boot (OpenSBI + kernel).
- **Richer devices.** No PLIC or a fuller 16550 (IER/IIR/FCR, baud divisors, IRQs). Console works
  via polling only. Low guest physical addresses below the RAM base are unmapped (aside from
  UART/CLINT).

## Requirements

Node.js 24 or newer. The CLI relies on `import.meta.main`, and the emulator uses `SharedArrayBuffer`
and worker threads.

## Getting started

Not on npm yet. This is a program, not a library — there is no API to import and never will be, just
a `ya-risc-v` command to run — and it stays marked `private` until the emulator is worth installing.
For now, clone the repository and run it from source.

```bash
npm install
npm run dev -- --ram-size 0x8000000 path/to/image.bin
```

`npm run dev` runs straight from TypeScript sources via `tsx`. The image is treated as a flat binary:
it is copied into guest DRAM at base `0x80000000` (reset PC matches). `--ram-size` is required
(decimal or `0x…` hex) and must be large enough for the image. UART MMIO is at `0x10000000`
(fixed 8-byte 16550 window).

```bash
npm run dev -- --ram-size 134217728 path/to/image.bin
```

Because traps vector to `mtvec`, a program that executes `ecall`, `ebreak`, or an unrecognized
encoding continues at the handler if one is installed; with `mtvec` left at 0 the hart re-fetches
from address 0 (unmapped — typically a repeated illegal-instruction trap unless a handler
advances). Images must be linked for the `0x80000000` RAM base; zeros past the image in DRAM
still decode as illegal instructions if execution falls through.

To build and run the compiled output instead (no `tsx` required):

```bash
npm run build
npm start -- --ram-size 0x8000000 path/to/image.bin
```

## Development

| Command              | What it does                                                             |
| -------------------- | ------------------------------------------------------------------------ |
| `npm run dev`        | Run the CLI from source via `tsx` (requires `--ram-size`)                |
| `npm test`           | Run the `node:test` suite over `src/**/*.test.ts` and `src/**/*.test.tsx` |
| `npm run lint`       | ESLint                                                                   |
| `npm run format`     | Prettier, writing changes                                                |
| `npm run type-check` | `tsc --noEmit`                                                           |
| `npm run check`      | Format check, lint, type-check, and tests — the full gate                |
| `npm run fix`        | Prettier write plus `eslint --fix`                                       |
| `npm run build`      | Bundle to `dist/`                                                        |

Optional [pre-commit](https://pre-commit.com) hooks are configured to run Prettier, `eslint --fix`,
and `tsc` over `src/`.

## Layout

```
src/
  index.ts                CLI: create emulator + TUI, start both, await emulator then TUI
  emulator/
    index.ts              Host-side create(); start()/stop() forward to CPU + CLINT + terminal
    types.ts              EmulatorCreateOptions / handle (private; re-exported)
    memory/
      index.ts            Public API: createMemory, loadBytes, storeBytes, Memory, …
      types.ts            Memory type (private; re-exported from index)
      ram.ts              RAM host mapping and byte access (private)
      uart.ts             16550 window, RX/TX queues (private)
      clint.ts            Guest decode, shadow R/W, tickClint, IRQ wire sample (private)
      layout.ts           Host SAB packing + guest address → region (private)
    cpu/
      index.ts            Host-side create()/start()/stop(); awaitable handle
      run.ts              Worker entry: sample CLINT wire, take IRQ, fetch/decode/execute
      decode.ts           Instruction decode into memoized execute thunks
      trap.ts             Trap/interrupt entry and mret/sret
      registers.ts        Register file: x0–x31, the program counter, and CSRs
      types.ts            Architectural state types (re-exported from index)
      instructions/       One file per opcode group (op-imm.ts, load.ts, branch.ts, …)
    clint/
      index.ts            Host-side create()/start()/stop()
      run.ts              Worker: timebase tick loop (calls tickClint)
      types.ts            Worker payload types (private to the package)
    terminal/
      index.ts            Host-side create()/start()/stop(); UART↔stream bridge
      run.ts              Worker entry
      types.ts            Worker payload types (private to the package)
  tui/                    Ink host UI (create()/start()/stop())
  types.ts                Shared architectural types (ReadonlyUint8Array)
  utils/
    bytes.ts              64-bit LE byte-array arithmetic
    tty.ts                VT100 encode/paint helpers for the TUI terminal pane
```

## Design notes

**Every architectural value is an 8-byte little-endian `Uint8Array`.** Registers, the program
counter, CSRs, and decoded immediates are all byte arrays, and arithmetic goes through explicit
helpers in `src/utils/bytes.ts` rather than JavaScript numbers or `BigInt`. This keeps 64-bit
semantics — wrapping, sign extension, logical versus arithmetic shifts — visible and exact instead of
relying on the host's number tower.

**Decode is separated from execution.** `decode` matches an opcode, extracts only the fields that
opcode uses, and returns a closure that performs the operation. Thunks are cached by the 32-bit
instruction word, so a hot loop decodes each distinct encoding once.

**Instructions own the program counter.** There is no implicit increment in the interpreter loop;
each instruction either advances the program counter or writes a jump or branch target, which mirrors
how the ISA actually specifies control flow.

**The CPU runs on a worker thread** over memory backed by a `SharedArrayBuffer`. Guest RAM loads and
stores are plain byte accesses rather than `Atomics`, so an unsynchronized host racing the guest
behaves like unsynchronized access to real memory. UART RX/TX queue metadata is an exception: the
host terminal worker and guest-facing UART side effects coordinate those rings with `Atomics`.

If you are pointing a coding agent at this repository, see [AGENTS.md](AGENTS.md) for the conventions
it should follow.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text.

Copyright 2026 Raymond Lam
