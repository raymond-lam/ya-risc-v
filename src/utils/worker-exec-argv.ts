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
 * `Worker` only accepts a subset of `process.execArgv`. Keep loader / condition
 * flags (tsx, `--conditions`, …) and drop the rest (node:test injects many).
 */
const workerExecArgv = (execArgv: readonly string[] = process.execArgv): string[] => {
  const kept: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index];
    if (arg === undefined) {
      continue;
    }
    const takesValue =
      arg === '--conditions' || arg === '--import' || arg === '--require' || arg === '-r';
    if (
      takesValue ||
      arg.startsWith('--conditions=') ||
      arg.startsWith('--import=') ||
      arg.startsWith('--require=')
    ) {
      kept.push(arg);
      if (takesValue) {
        const value = execArgv[index + 1];
        if (value !== undefined && !value.startsWith('-')) {
          kept.push(value);
          index += 1;
        }
      }
    }
  }
  return kept;
};

export default workerExecArgv;
