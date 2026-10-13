/**
 * pending-writer-turns — which accepted writer turns still wait for the model, from the
 * thread's pending inbox. The view model marks these rows queued.
 */
import type { ThreadPendingInbox } from "@meridian/contracts/threads";

/** Writer turns still waiting for the model to read them; inbox IDs are turn IDs. */
export function queuedWriterTurnIds(pending: ThreadPendingInbox): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of pending.items) {
    // A control is writer-authored but never a turn; it renders as its own row.
    if (
      item.intent !== "control" &&
      item.provenance.kind === "writer" &&
      item.deliveryState === "waiting"
    )
      ids.add(item.id);
  }
  return ids;
}
