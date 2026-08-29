# ya-risc-v

Yet another RISC-V emulator, written from scratch in TypeScript for Node.

> [!WARNING]
> **This is a work in progress and nowhere near finished.** The RV64I base integer instruction set
> executes and is covered by tests, but there is no trap handling, no CSR instructions, no
> extensions beyond the base set, and no operating-system or device support. It cannot boot anything
> real yet. Anything listed under [Not yet implemented](#not-yet-implemented) is unfinished work
> rather than a deliberate limit on scope — the goal is a much more complete machine than what is
> here today.

## Status

### Working today

- The full **RV64I** base integer instruction set: `lui`, `auipc`, `jal`, `jalr`, the six branches,
  all seven loads, all four stores, the register–immediate and register–register integer ops, and
  the RV64-specific 32-bit forms (`addiw`, `sllw`, `sraw`, …).
- `fence`, decoded and executed as a no-op, which is architecturally legal for this emulator.
- Integer registers x0–x31, the program counter, and a dense 4096-entry CSR file, with x0 and the
  identity CSRs (`mvendorid`, `marchid`, `mimpid`, `mhartid`) hardwired read-only.
- A fetch/decode/execute loop running on a worker thread against shared guest memory, with decoded
  instructions memoized by their 32-bit encoding.
- 51 unit tests over the decoder, the instructions, the register file, memory, and the byte helpers.

### Not yet implemented

- **Traps and exceptions.** `ecall`, `ebreak`, and illegal instructions currently throw a JavaScript
  error, which terminates the worker instead of trapping into a handler.
- **CSR instructions.** The CSR file exists, but `csrrw`/`csrrs`/`csrrc` and their immediate forms
  are not decoded yet (Zicsr).
- **Extensions.** No M (multiply/divide), A (atomics), F/D (floating point), or C (compressed).
- **Privilege levels, interrupts, timers, and virtual memory.** No machine/supervisor/user modes,
  no `mstatus`/`mtvec` semantics, no paging.
- **Alignment and bounds checks.** Misaligned accesses are not faulted, and out-of-range loads read
  as zero instead of trapping.
- **A real address space.** Addresses are currently truncated to their low 32 bits, and guest memory
  is sized to exactly the image length, so there is no room for a stack or heap beyond the program
  image.
- **Program loading.** Images are flat binaries copied to address 0; there is no ELF loader.
- **Devices and console I/O.** Nothing is memory-mapped, so a guest has no way to talk to the host.

## Requirements

Node.js 24 or newer. The CLI relies on `import.meta.main`, and the emulator uses `SharedArrayBuffer`
and worker threads.

## Getting started

Not on npm yet. This is a program, not a library — there is no API to import and never will be, just
a `ya-risc-v` command to run — and it stays marked `private` until the emulator is worth installing.
For now, clone the repository and run it from source.

```bash
npm install
npm run dev path/to/image.bin
```

`npm run dev` runs straight from TypeScript sources via `tsx`. The image is treated as a flat binary:
it is copied into guest memory at address 0 and the program counter resets to 0.

Because traps are not implemented, a program that executes `ecall`, `ebreak`, or an unrecognized
encoding will fail with a thrown error rather than being handled by the guest. Running off the end of
the image reads zeros, which decodes as an illegal instruction and stops the machine.

To build and run the compiled output instead:

```bash
npm run build
npm start path/to/image.bin
```

## Development

| Command              | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `npm run dev`        | Run the CLI from source via `tsx`                         |
| `npm test`           | Run the `node:test` suite over `src/**/*.test.ts`         |
| `npm run lint`       | ESLint                                                    |
| `npm run format`     | Prettier, writing changes                                 |
| `npm run type-check` | `tsc --noEmit`                                            |
| `npm run check`      | Format check, lint, type-check, and tests — the full gate |
| `npm run fix`        | Prettier write plus `eslint --fix`                        |
| `npm run build`      | Compile to `dist/`                                        |

Optional [pre-commit](https://pre-commit.com) hooks are configured to run Prettier, `eslint --fix`,
and `tsc` over `src/`.

## Layout

```
src/
  index.ts              CLI: load an image, create memory, start the CPU
  memory.ts             Guest memory over a SharedArrayBuffer, plus load/store helpers
  ReadonlyUint8Array.ts Uint8Array whose writes are dropped after construction
  cpu/
    index.ts            Host-side run(); spawns the worker, returns an awaitable handle
    run.ts              Worker entry point and the fetch/decode/execute loop
    decode.ts           Instruction decode into memoized execute thunks
    registers.ts        Register file: x0–x31, the program counter, and CSRs
    types.ts            Architectural state types
    instructions/       One file per opcode group (op-imm.ts, load.ts, branch.ts, …)
  utils/
    bytes.ts            64-bit little-endian byte-array arithmetic
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

**The CPU runs on a worker thread** over memory backed by a `SharedArrayBuffer`. Loads and stores are
plain byte accesses rather than `Atomics`, so an unsynchronized host racing the guest behaves like
unsynchronized access to real memory.

If you are pointing a coding agent at this repository, see [AGENTS.md](AGENTS.md) for the conventions
it should follow.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text.

Copyright 2026 Raymond Lam
