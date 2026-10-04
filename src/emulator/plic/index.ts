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
 * PLIC device public API — guest MMIO, source pending, and IRQ wire samples.
 */

import { PLIC_HOST_MEIP_WIRE_OFFSET, plicRegion } from '#emulator/plic/layout';
import { resetPlicGatewayLock } from '#emulator/plic/gateway';
import { setPlicContextWire } from '#emulator/plic/wires';
import type { Memory } from '#emulator/memory';
import { bigIntAsNumber } from '#utils/int';

export {
  PLIC_GUEST_BYTE_LENGTH,
  PLIC_HOST_BYTE_LENGTH,
  PLIC_REGION_ID,
  PLIC_SOURCE_UART,
} from '#emulator/plic/layout';
export { loadBytesFromPlic, storeBytesToPlic } from '#emulator/plic/memory';
export { setPlicSourcePending } from '#emulator/plic/gateway';
export {
  isPlicMachineExternalPending,
  isPlicSupervisorExternalPending,
} from '#emulator/plic/wires';

/** Initialize PLIC shadows: priorities/enables/thresholds/claimed clear; wires low. */
const initializePlic = (memory: Memory): void => {
  const base = bigIntAsNumber(plicRegion(memory).hostIndex);
  memory.bytes.fill(0, base, base + PLIC_HOST_MEIP_WIRE_OFFSET);
  resetPlicGatewayLock(memory);
  setPlicContextWire(memory, 'machine', false);
  setPlicContextWire(memory, 'supervisor', false);
};

export { initializePlic };
