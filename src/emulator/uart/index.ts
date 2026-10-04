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
 * UART 16550 public API — guest MMIO, host RX/TX queues, and region sizing.
 */

export { loadBytesFromUart, storeBytesToUart } from '#emulator/uart/memory';
export { waitUartTransmit } from '#emulator/uart/queues';
export { popUartTransmit, pushUartReceive } from '#emulator/uart/registers';
export {
  UART_GUEST_BYTE_LENGTH,
  UART_HOST_BYTE_LENGTH,
  UART_REGION_ID,
} from '#emulator/uart/region';
