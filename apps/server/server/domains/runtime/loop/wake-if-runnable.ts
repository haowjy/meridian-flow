import type { ThreadId } from "@meridian/contracts/runtime";
import type { RuntimeDelivery } from "./delivery/runtime-delivery.js";
import { next } from "./next-inbox-work.js";
import type { RunStarter } from "./ports.js";

export function createWakeIfRunnable(deps: {
  delivery: Pick<RuntimeDelivery, "selectPending">;
  runStarter: RunStarter;
  shutdown?: { started: boolean };
}): (threadId: ThreadId) => Promise<void> {
  const shutdown = deps.shutdown ?? { started: false };
  return async (threadId) => {
    if (shutdown.started) return;
    const pending = await deps.delivery.selectPending(threadId);
    const selection = next(pending, "run_start");
    if (!shutdown.started && selection.kind !== "none") await deps.runStarter.start(threadId);
  };
}
