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
import { popUartTransmit, pushUartReceive, waitUartTransmit } from '#emulator/uart';

/**
 * Pump UART TX bytes to stdout until the ring is idle, stop is requested, or the
 * stream dies. Returns `true` when stop was requested with the ring drained, `false`
 * when the stream died mid-drain (the consumer is gone; nothing more can flush).
 *
 * `stopPromise` is the graceful-shutdown signal from the host. The idle wait is
 * raced against it so a stop request is never stuck behind an indefinite wait
 * for bytes that will never arrive; when the stop wins, one final drain pass
 * empties the ring before the pump returns. No `delay` / `setTimeout` anywhere in
 * this path — shutdown completes on events, not time.
 */
const pumpTransmit = async (
  memory: TerminalWorkerData['memory'],
  stdout: Writable,
  stopPromise: Promise<void>,
  isStopRequested: () => boolean
): Promise<boolean> => {
  for (;;) {
    if (!(await drainTransmitRing(memory, stdout))) {
      return false;
    }
    await Promise.race([waitUartTransmit(memory), stopPromise]);
    if (isStopRequested()) {
      // Stop won the race while the pump was parked: the ring can hold bytes pushed
      // since the last pass, so drain once more before ending the stream. This pass
      // pops until the ring is empty; because the CPU worker is torn down around the
      // same moment as the stop (the syscon power cut stops the worker), it is bounded
      // by the ring capacity in practice. Bytes the guest enqueues after this pass —
      // or while it runs, if the worker has not been torn down yet — are dropped: a
      // host-initiated stop guarantees the bytes already in the ring, not an
      // unbounded live producer.
      if (!(await drainTransmitRing(memory, stdout))) {
        return false;
      }
      return true;
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
  try {
    return await Promise.race([
      once(stdout, 'drain').then((): true => true),
      once(stdout, 'close').then((): false => false),
    ]);
  } catch {
    // `once` rejects when the emitter emits `error`: the stream is dead.
    return false;
  }
};

/**
 * Pop TX bytes and write them to `stdout` until the ring is empty. Each iteration
 * pops exactly one byte, so the loop terminates when the ring drains; it returns
 * `false` if the stream dies mid-drain (remaining ring bytes are unreachable).
 */
const drainTransmitRing = async (
  memory: TerminalWorkerData['memory'],
  stdout: Writable
): Promise<boolean> => {
  let value = popUartTransmit(memory);
  while (value !== null) {
    // `write` returns false under backpressure; wait for `drain` before the next byte.
    if (!stdout.write(Buffer.from([value]))) {
      if (!(await drainOrClosed(stdout))) {
        return false;
      }
    }
    value = popUartTransmit(memory);
  }
  return true;
};

const main = async (): Promise<void> => {
  const { memory, stdin: stdinWeb, stdout: stdoutWeb } = workerData as TerminalWorkerData;
  const stdin = Readable.fromWeb(stdinWeb);
  const stdout = Writable.fromWeb(stdoutWeb);

  const onStdinData = (chunk: Buffer): void => {
    for (const byte of chunk) {
      pushUartReceive(memory, byte);
    }
  };
  stdin.on('data', onStdinData);
  const stopStdin = (): void => {
    stdin.off('data', onStdinData);
  };
  stdin.once('close', stopStdin);
  parentPort?.once('close', stopStdin);

  let stopRequested = false;
  const stopPromise = new Promise<void>((resolve) => {
    parentPort?.once('message', () => {
      stopRequested = true;
      resolve();
    });
  });

  const stopped = await pumpTransmit(memory, stdout, stopPromise, () => stopRequested);

  if (stopped) {
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
