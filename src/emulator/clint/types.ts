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

/* eslint-disable import/prefer-default-export -- clint worker payload types */
import type { Memory } from '#emulator/memory';

/** Host arguments to create the CLINT timebase worker. */
type ClintCreateOptions = {
  /** Shared guest address space (CLINT shadows and timer wire live here). */
  memory: Memory;
};

/** Startup payload handed to the CLINT worker. */
type ClintWorkerData = ClintCreateOptions;

type ClintHandle = Promise<void> & {
  /** Spawn the CLINT tick worker. Throws if already started or already stopped. */
  start: () => void;
  /** Stop the worker. Throws if not started; idempotent after the first stop. */
  stop: () => void;
};

export type { ClintCreateOptions, ClintWorkerData, ClintHandle };
