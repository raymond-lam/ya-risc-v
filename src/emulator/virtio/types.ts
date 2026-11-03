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

import type { Memory } from '#emulator/memory';

/** Host arguments to create the disk worker. */
type VirtioDiskCreateOptions = {
  /** Shared guest address space (the disk channel + staging window live here). */
  memory: Memory;
  /** Raw disk image path. Always non-null: a diskless emulator never spawns this worker. */
  diskImagePath: string;
};

/** Startup payload handed to the disk worker. */
type VirtioDiskWorkerData = VirtioDiskCreateOptions;

type VirtioDiskHandle = Promise<void> & {
  /** Spawn the disk worker. Throws if already started or already stopped. */
  start: () => void;
  /** Stop the worker. Idempotent after the first stop. */
  stop: () => void;
};

export type { VirtioDiskCreateOptions, VirtioDiskWorkerData, VirtioDiskHandle };
