/**
 * The one worker-thread pool for file conversions (image previews, EPUB and PDF text): a decoder
 * that is synchronous or hostile-input-bound must never run on the server's event loop, and only
 * a thread can be stopped. Each pool owns its jobs: a worker that crashes, runs out of memory or
 * outlives the job's deadline is terminated and replaced, and its job fails with a
 * `WorkerPoolError`.
 *
 * The protocol: the pool posts `{ id, input }`; the worker answers `{ id, reply }` and reports a
 * failure in its reply, not by throwing (a job with no reply runs to its deadline). A worker file
 * imports only packages and types: Node loads it as it is when a test starts it, and nitro bundles
 * it into its own chunk (`nitro.config.ts`).
 */
import { Worker } from "node:worker_threads";

export type WorkerFailure = "unavailable" | "timeout" | "crashed";

export class WorkerPoolError extends Error {
  constructor(readonly reason: WorkerFailure) {
    super(`worker failed: ${reason}`);
  }
}

type Job<In, Out> = {
  input: In;
  timeoutMs: number;
  resolve(reply: Out): void;
  reject(error: WorkerPoolError): void;
};
type Slot<In, Out> = {
  worker: Worker;
  job?: Job<In, Out> & { id: number; timer: NodeJS.Timeout };
};

export type WorkerPool<In, Out> = {
  /** Runs one job on a free worker; `timeoutMs` counts from when a worker takes it. */
  run(input: In, timeoutMs: number): Promise<Out>;
};

export function createWorkerPool<In, Out>(options: {
  /** The worker file, written `new URL("./x.ts", import.meta.url)` where the pool is made. */
  entry: URL;
  size: number;
  /** Each worker's JS heap cap; buffers outside the heap are bounded by what the job reads. */
  maxOldGenerationSizeMb: number;
  /** A worker whose reply makes it unfit for another job (a decoder left in a bad state) is replaced. */
  retireAfter?(input: In, reply: Out): boolean;
}): WorkerPool<In, Out> {
  const slots: Slot<In, Out>[] = [];
  const queue: Job<In, Out>[] = [];
  let nextJobId = 0;

  /** Ends the slot's job and, if the worker is gone, replaces it. */
  function settle(slot: Slot<In, Out>, outcome: { reply: Out } | { error: WorkerPoolError }): void {
    const job = slot.job;
    if (!job) return;
    clearTimeout(job.timer);
    slot.job = undefined;
    if ("error" in outcome) job.reject(outcome.error);
    else job.resolve(outcome.reply);
    pump();
  }

  function retire(slot: Slot<In, Out>): void {
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
  }

  function spawnSlot(): Slot<In, Out> {
    const worker = new Worker(options.entry, {
      resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb },
    });
    const slot: Slot<In, Out> = { worker };
    worker.on("message", (message: { id: number; reply: Out }) => {
      const job = slot.job;
      if (job?.id !== message.id) return;
      if (options.retireAfter?.(job.input, message.reply)) {
        retire(slot);
        void worker.terminate();
      }
      settle(slot, { reply: message.reply });
    });
    // A crash or out-of-memory kill ends the worker: fail its job and drop the slot; the next
    // job starts a fresh one.
    const onGone = (reason: WorkerFailure) => {
      retire(slot);
      settle(slot, { error: new WorkerPoolError(reason) });
    };
    worker.on("error", (error) =>
      onGone(
        (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" ? "unavailable" : "crashed",
      ),
    );
    worker.on("exit", () => onGone("crashed"));
    // After the listeners: adding a 'message' listener re-refs the worker. Unreffed, an idle pool
    // never holds the process open; a pending job's timer does.
    worker.unref();
    return slot;
  }

  function pump(): void {
    while (queue.length > 0) {
      let slot = slots.find((candidate) => !candidate.job);
      if (!slot && slots.length < options.size) {
        slot = spawnSlot();
        slots.push(slot);
      }
      const job = queue.shift();
      if (!slot || !job) return;
      const taken = slot;
      const id = nextJobId++;
      const timer = setTimeout(() => {
        retire(taken);
        settle(taken, { error: new WorkerPoolError("timeout") });
        void taken.worker.terminate();
      }, job.timeoutMs);
      taken.job = { ...job, id, timer };
      taken.worker.postMessage({ id, input: job.input });
    }
  }

  return {
    run: (input, timeoutMs) =>
      new Promise((resolve, reject) => {
        queue.push({ input, timeoutMs, resolve, reject });
        pump();
      }),
  };
}
