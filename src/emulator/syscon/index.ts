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
 * Syscon public API — guest MMIO for poweroff and reboot, plus the host request watch.
 */

export {
  SYSCON_GUEST_BYTE_LENGTH,
  SYSCON_HOST_BYTE_LENGTH,
  SYSCON_POWEROFF_OFFSET,
  SYSCON_POWEROFF_VALUE,
  SYSCON_REBOOT_OFFSET,
  SYSCON_REBOOT_VALUE,
  SYSCON_REGION_ID,
  cancelSysconWatch,
  loadBytesFromSyscon,
  storeBytesToSyscon,
  watchSyscon,
} from '#emulator/syscon/region';
