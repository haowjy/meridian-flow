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
  run(input: In, timeoutMs: number): Promise<Out>;
};

export function createWorkerPool<In, Out>(options: {
  entry: URL;
  size: number;
  execArgv?: string[];
  maxOldGenerationSizeMb: number;
  retireAfter?(input: In, reply: Out): boolean;
}): WorkerPool<In, Out> {
  const slots: Slot<In, Out>[] = [];
  const queue: Job<In, Out>[] = [];
  let nextJobId = 0;

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
      execArgv: options.execArgv,
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
    // Call `unref()` after the listeners: adding a 'message' listener re-refs the worker, and only an unreffed idle pool lets the process exit
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
      if (!slot) return;
      const job = queue.shift() as Job<In, Out>;
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
