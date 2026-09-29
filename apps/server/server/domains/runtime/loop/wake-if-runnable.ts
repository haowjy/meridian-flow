/** Re-reads a thread's queue after a claim release and starts only runnable work. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { next } from "./next-inbox-work.js";
import type { RunStarter } from "./ports.js";
import type { RuntimeDelivery } from "./runtime-delivery.js";

export function createWakeIfRunnable(deps: {
  delivery: Pick<RuntimeDelivery, "refreshPending" | "selectPending">;
  runStarter: RunStarter;
  shutdown?: { started: boolean };
}): (threadId: ThreadId) => Promise<void> {
  const shutdown = deps.shutdown ?? { started: false };
  return async (threadId) => {
    if (shutdown.started) return;
    await deps.delivery.refreshPending(threadId);
    if (shutdown.started) return;
    const pending = await deps.delivery.selectPending(threadId);
    const selection = next(pending, "run_start");
    if (!shutdown.started && selection.kind !== "none") await deps.runStarter.start(threadId);
  };
}
