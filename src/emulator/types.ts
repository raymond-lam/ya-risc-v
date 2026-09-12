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

/* eslint-disable import/prefer-default-export -- emulator create option / handle types */
import type { Readable, Writable } from 'node:stream';

/**
 * Host arguments to create the emulator (CPU + UART terminal workers).
 * RAM / UART bases and reset PC use the built-in defaults.
 */
type EmulatorCreateOptions = {
  /** Flat program image copied into guest RAM at the default RAM base. */
  image: Uint8Array;
  /** Keystrokes into the guest (UART RX). */
  stdin: Readable;
  /** Bytes out of the guest (UART TX) for the host display. */
  stdout: Writable;
};

type EmulatorHandle = Promise<void> & {
  /** Start the CPU and UART terminal workers. */
  start: () => void;
  /** Stop both workers. */
  stop: () => void;
};

export type { EmulatorCreateOptions, EmulatorHandle };
