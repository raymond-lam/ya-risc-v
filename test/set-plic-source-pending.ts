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
import { setPlicSourcePending as setPending, withPlicGatewayLock } from '#emulator/plic';

const setPlicSourcePending = (memory: Memory, source: number, pending: boolean): Promise<void> =>
  withPlicGatewayLock(memory, () => setPending(memory, source, pending));

export default setPlicSourcePending;
