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

import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { parentPort, workerData } from 'node:worker_threads';
import type { TerminalWorkerData } from '#emulator/terminal/types';
import {
  dequeueTransmit,
  popUartTransmit,
  pushUartReceive,
  waitUartTransmit,
} from '#emulator/uart';

/** Pump output while running. A pending dequeue must not consume bytes after stop. */
const pumpTransmit = async (
  memory: TerminalWorkerData['memory'],
  stdout: Writable,
  stopSignal: AbortSignal
): Promise<boolean> => {
  while (!stopSignal.aborted) {
    const value = await popUartTransmit(memory, () => stopSignal.aborted);
    if (value !== null) {
      if (!stdout.write(Buffer.from([value])) && !(await drainOrClosed(stdout))) {
        return false;
      }
    } else if (!stopSignal.aborted) {
      await waitUartTransmit(memory);
    }
  }
  return true;
};

/** On stop, drain the TX queue without waiting on the gateway or refreshing IRQs. */
const drainTransmitRing = async (memory: TerminalWorkerData['memory'], stdout: Writable) => {
  for (;;) {
    const entry = dequeueTransmit(memory);
    if (entry === null) {
      return true;
    }
    if (!stdout.write(Buffer.from([entry.value])) && !(await drainOrClosed(stdout))) {
      return false;
    }
  }
};

/**
 * Wait until `stdout` drains, or until the stream dies. Returns `true` when the
 * stream drained, `false` on `close` or on an `error` (for example EPIPE while
 * backpressured).
 *
 * A plain `await once(stdout, 'drain')` never settles if the stream is destroyed
 * or errors while backpressured: the worker would hang mid-write, and the host's
 * force-terminate fallback would kill it with bytes still queued, losing them.
 * Racing the drain wait against the stream's death events guarantees the wait
 * settles, and a dead stream terminates the drain path cleanly instead of
 * spinning on events that can never fire.
 */
const drainOrClosed = async (stdout: Writable): Promise<boolean> => {
  const controller = new AbortController();
  try {
    return await Promise.race([
      once(stdout, 'drain', { signal: controller.signal }).then((): true => true),
      once(stdout, 'close', { signal: controller.signal }).then((): false => false),
    ]);
  } catch {
    // `once` rejects when the emitter emits `error`: the stream is dead.
    return false;
  } finally {
    controller.abort();
  }
};

const main = async (): Promise<void> => {
  const { memory, stdin: stdinWeb, stdout: stdoutWeb } = workerData as TerminalWorkerData;
  const stdin = Readable.fromWeb(stdinWeb);
  const stdout = Writable.fromWeb(stdoutWeb);

  let receiveQueue = Promise.resolve();
  let stdinStopped = false;
  const onStdinData = (chunk: Buffer): void => {
    stdin.pause();
    receiveQueue = receiveQueue.then(async () => {
      for (const byte of chunk) {
        if (stdinStopped) {
          break;
        }
        await pushUartReceive(memory, byte);
      }
      if (!stdinStopped) {
        stdin.resume();
      }
    });
  };
  stdin.on('data', onStdinData);
  const stopStdin = (): void => {
    stdinStopped = true;
    stdin.off('data', onStdinData);
    stdin.pause();
  };
  stdin.once('close', stopStdin);
  parentPort?.once('close', stopStdin);

  const stopController = new AbortController();
  const stopRequested = Promise.withResolvers<boolean>();
  parentPort?.once('message', () => {
    stopStdin();
    stopController.abort();
    stopRequested.resolve(true);
  });

  // Race once for the worker's lifetime, not once per transmitted byte.
  const stopped = await Promise.race([
    pumpTransmit(memory, stdout, stopController.signal),
    stopRequested.promise,
  ]);
  stopStdin();
  // A pending RX operation may be parked on an orphaned gateway; discard it on stop.
  if (!stopped) {
    await receiveQueue;
  }

  if (stopped && (await drainTransmitRing(memory, stdout))) {
    // Drain handshake tail: end the stream so every buffered byte is flushed to
    // the host, and await `finish` so the writes have actually completed before
    // the isolate goes away. `process.exit` terminates immediately and would
    // otherwise destroy bytes still sitting in the stream's write queue. No byte
    // is lost in this normal path: every byte popped from the ring was accepted
    // by `write` (a false return only means "buffered, apply backpressure" —
    // accepted bytes are never dropped), `end()` flushes the remaining queue, and
    // `finish` fires only once all queued bytes have reached the host, so exiting
    // after `finish` cannot lose one.
    stdout.end();
    try {
      await Promise.race([once(stdout, 'finish'), once(stdout, 'close')]);
    } catch {
      // The stream errored (for example EPIPE): `finish` can never fire, and the
      // consumer is gone, so there is nothing left to flush — exit cleanly.
    }
  }
  // A dead stream (the pump returned `false`, or the tail above raced a close or
  // error) is termination of the drain path: exit 0 rather than waiting on events
  // that will never come.
  process.exit(0);
};

if (parentPort !== null) {
  void main();
}
