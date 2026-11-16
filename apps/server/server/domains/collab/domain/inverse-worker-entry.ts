/**
 * Worker thread that plans one inverse (`runInverseJob`) so its CPU never runs on the server's
 * event loop. `inverse-worker.ts` starts it with `new URL("./inverse-worker-entry.ts",
 * import.meta.url)`, which `nitro.config.ts` bundles into its own chunk; it imports only
 * packages and types.
 */

import { parentPort } from "node:worker_threads";
import { type InverseJob, runInverseJob } from "@meridian/agent-edit/integration";
import type { InverseWorkerReply } from "./inverse-worker.js";

parentPort?.on("message", ({ id, input }: { id: number; input: InverseJob }) => {
  let reply: InverseWorkerReply;
  try {
    reply = { value: runInverseJob(input) };
  } catch (error) {
    reply =
      error instanceof Error
        ? { error: error.message, stack: error.stack }
        : { error: String(error) };
  }
  parentPort?.postMessage({ id, reply });
});
