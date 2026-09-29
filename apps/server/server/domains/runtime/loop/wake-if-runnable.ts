/** Re-reads a thread's queue after a claim release and starts only runnable work. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { next } from "./next-inbox-work.js";
import type { RunStarter } from "./ports.js";
import type { RuntimeDelivery } from "./runtime-delivery.js";

export function createWakeIfRunnable(deps: {
  delivery: Pick<RuntimeDelivery, "refreshPending" | "selectPending">;
  runStarter: RunStarter;
  shutdown?: { started: boolean };
}): (threadId: ThreadId, excludedReceiptIds?: readonly string[]) => Promise<void> {
  const shutdown = deps.shutdown ?? { started: false };
  return async (threadId, excludedReceiptIds = []) => {
    if (shutdown.started) return;
    await deps.delivery.refreshPending(threadId);
    if (shutdown.started) return;
    const excluded = new Set(excludedReceiptIds);
    const pending = await deps.delivery.selectPending(threadId);
    const selection = next(
      pending.filter((row) => !excluded.has(row.id)),
      "run_start",
    );
    // A failed reply leaves its receipt pending for the periodic sweep. Do not
    // let a queued command bypass that older message; a newly arrived message
    // may still wake promptly and will be retried with the original receipt.
    const onlyCommandBehindReceipt =
      excluded.size > 0 &&
      selection.kind === "control" &&
      !selection.rows.some((row) => row.intent === "message");
    if (!shutdown.started && selection.kind !== "none" && !onlyCommandBehindReceipt)
      await deps.runStarter.start(threadId);
  };
}
