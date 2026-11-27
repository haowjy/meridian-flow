import { Worker } from "node:worker_threads";
import type { MatchReply, MatchRequest, MatchValue } from "./match-worker.js";

const MAX_WORKERS = 4;

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

function discard(worker: Worker): void {
  void worker.terminate();
  live -= 1;
  const next = waiting.shift();
  if (next) next(spawn());
}

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
