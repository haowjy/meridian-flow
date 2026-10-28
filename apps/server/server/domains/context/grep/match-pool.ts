/**
 * The worker threads that run grep's matching (`match-worker.ts`), and the deadline that ends them.
 *
 * A pool grows on demand to {@link MAX_WORKERS} and keeps its idle threads, so the first grep pays
 * the start-up and later ones don't. A thread serves one request at a time, so a slow request holds
 * only its own thread: when that request's signal aborts, the thread is terminated (the one
 * way to stop a running `re2js` call) and replaced on the next demand. Callers beyond the cap queue
 * for a free thread, each for no longer than its own signal. Requests carry no pool state, so any
 * thread can serve any of them and a terminated thread loses nothing but the request that ran there.
 */
import { Worker } from "node:worker_threads";
import type { MatchReply, MatchRequest, MatchValue } from "./match-worker.js";

/** Matching threads alive at once. Each costs memory, and the cap bounds the CPU that grep may take. */
const MAX_WORKERS = 4;

/** The signal aborted before matching finished. */
export class GrepStopped extends Error {
  constructor() {
    super("grep stopped");
  }
}

const idle: Worker[] = [];
const waiting: Array<(worker: Worker) => void> = [];
let live = 0;

function spawn(): Worker {
  live += 1;
  return new Worker(new URL("./match-worker.ts", import.meta.url));
}

function acquire(signal: AbortSignal): Promise<Worker> {
  const worker = idle.pop() ?? (live < MAX_WORKERS ? spawn() : undefined);
  if (worker) {
    worker.ref();
    return Promise.resolve(worker);
  }
  return new Promise((resolve, reject) => {
    const turn = (next: Worker) => {
      signal.removeEventListener("abort", leave);
      next.ref();
      resolve(next);
    };
    const leave = () => {
      waiting.splice(waiting.indexOf(turn), 1);
      reject(new GrepStopped());
    };
    waiting.push(turn);
    signal.addEventListener("abort", leave, { once: true });
  });
}

function release(worker: Worker): void {
  const next = waiting.shift();
  if (next) {
    next(worker);
    return;
  }
  worker.unref();
  idle.push(worker);
}

/** Ends a thread that timed out or failed; a waiting caller gets a fresh one. */
function discard(worker: Worker): void {
  void worker.terminate();
  live -= 1;
  const next = waiting.shift();
  if (next) next(spawn());
}

/** One request on a free thread. Rejects with {@link GrepStopped} when `signal` aborts first. */
export async function runMatch<Op extends MatchRequest["op"]>(
  request: Extract<MatchRequest, { op: Op }>,
  signal: AbortSignal,
): Promise<MatchValue[Op]> {
  if (signal.aborted) throw new GrepStopped();
  const worker = await acquire(signal);
  let reply: MatchReply<Op>;
  try {
    reply = await new Promise<MatchReply<Op>>((resolve, reject) => {
      const settle = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        signal.removeEventListener("abort", onAbort);
      };
      const onMessage = (message: MatchReply<Op>) => {
        settle();
        resolve(message);
      };
      const onError = (error: Error) => {
        settle();
        reject(error);
      };
      const onExit = () => onError(new Error("grep worker exited"));
      const onAbort = () => onError(new GrepStopped());
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      signal.addEventListener("abort", onAbort, { once: true });
      // An abort between the entry check and this listener never fires the listener.
      if (signal.aborted) return onAbort();
      worker.postMessage(request);
    });
  } catch (cause) {
    discard(worker);
    throw cause;
  }
  release(worker);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
