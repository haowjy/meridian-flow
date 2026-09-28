/** Re-reads a thread's queue after a claim release and starts only runnable work. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { next } from "./next-inbox-work.js";
import type { RunStarter } from "./ports.js";
import type { RuntimeDelivery } from "./runtime-delivery.js";

export function createWakeIfRunnable(deps: {
  delivery: Pick<RuntimeDelivery, "refreshPending" | "selectPending">;
  runStarter: RunStarter;
}): (threadId: ThreadId) => Promise<void> {
  return async (threadId) => {
    await deps.delivery.refreshPending(threadId);
    if (next(await deps.delivery.selectPending(threadId), "run_start").kind !== "none")
      await deps.runStarter.start(threadId);
  };
}
