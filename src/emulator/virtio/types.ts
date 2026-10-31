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

/**
 * Types shared by VirtIO-MMIO device worker and host.
 */

import type { Memory } from '#emulator/memory';

/** VirtIO-MMIO device workerData passed to the Worker. */
export type VirtioWorkerData = {
  memory: Memory;
  image: Uint8Array;
};

/** Host-side VirtIO handle with Promise lifecycle. */
export type VirtioHandle = Promise<void> & {
  start: () => void;
  stop: () => void;
};
