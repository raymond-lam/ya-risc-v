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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The hart worker imports `isClintMachineTimerPending` / `isClintMachineSoftwarePending`
 * from `#emulator/memory`. Tree-shaking must drop the host CLINT `create` path
 * (`new Worker` → `#emulator/clint/run`).
 */
const cpuWorkerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'emulator',
  'cpu',
  'run.js'
);
const source = readFileSync(cpuWorkerPath, 'utf8');

const hostClintMarkers = ['#emulator/clint/run', 'emulator/clint/run'];
for (const marker of hostClintMarkers) {
  if (source.includes(marker)) {
    console.error(
      `assert-cpu-worker-tree-shake: ${cpuWorkerPath} still contains host CLINT worker marker ${JSON.stringify(marker)}`
    );
    process.exit(1);
  }
}

if (/\bnew Worker\b/.test(source)) {
  console.error(
    `assert-cpu-worker-tree-shake: ${cpuWorkerPath} still contains new Worker (host spawn path)`
  );
  process.exit(1);
}

for (const api of ['isClintMachineTimerPending', 'isClintMachineSoftwarePending']) {
  if (!source.includes(api)) {
    console.error(
      `assert-cpu-worker-tree-shake: ${cpuWorkerPath} missing ${api} (sample API shaken away?)`
    );
    process.exit(1);
  }
}
