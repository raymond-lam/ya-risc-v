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

/* eslint-disable import/prefer-default-export -- terminal worker payload types */
import type { Readable, Writable } from 'node:stream';
import type { Memory } from '#emulator/memory';

/**
 * Host arguments to create the terminal worker. Node streams are converted to
 * transferable Web streams when `start` runs.
 */
type TerminalCreateOptions = {
  /** Shared guest address space (UART RX/TX rings live here). */
  memory: Memory;
  /** Keystrokes into the guest (UART RX). */
  stdin: Readable;
  /** Bytes out of the guest (UART TX) for the host display. */
  stdout: Writable;
};

/** Startup payload after stream transfer into the worker. */
type TerminalWorkerData = {
  memory: Memory;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
};

type TerminalHandle = Promise<void> & {
  /** Spawn the terminal worker. */
  start: () => void;
  /** Stop the worker, or settle immediately if it never started. */
  stop: () => void;
};

export type { TerminalCreateOptions, TerminalWorkerData, TerminalHandle };
