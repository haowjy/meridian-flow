/**
 * The worker threads that plan inverses. Planning one large document is hundreds of milliseconds
 * of synchronous CPU; on the event loop it queues every other request on the server behind it.
 * The worker gets bytes (the documents' updates and the history), never the capture's Y.Docs,
 * which stay with `capturedAttempt` and are destroyed with it.
 */
import type { ComputedInverse, InverseJob } from "@meridian/agent-edit/integration";
import { createWorkerPool, WorkerPoolError } from "../../file-intake/worker-pool.js";

export type InverseWorkerReply = { value: ComputedInverse } | { error: string };

/** A plan that outlives this is stuck: its worker is replaced and the command fails. */
const JOB_TIMEOUT_MS = 120_000;

/** Threads that plan at once; a caller with many documents keeps this many jobs in flight. */
export const INVERSE_WORKERS = 2;

const pool = createWorkerPool<InverseJob, InverseWorkerReply>({
  entry: new URL("./inverse-worker-entry.ts", import.meta.url),
  size: INVERSE_WORKERS,
  maxOldGenerationSizeMb: 1024,
});

/** `runInverseJob` on a worker thread; fails as the in-process run fails, with an Error. */
export async function planInverseOffThread(job: InverseJob): Promise<ComputedInverse> {
  let reply: InverseWorkerReply;
  try {
    reply = await pool.run(job, JOB_TIMEOUT_MS);
  } catch (error) {
    if (!(error instanceof WorkerPoolError)) throw error;
    throw new Error(`Inverse planning failed: ${error.reason}`);
  }
  if ("error" in reply) throw new Error(reply.error);
  return reply.value;
}
