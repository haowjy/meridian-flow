/**
 * Pure helpers for accepted writer-turn queue status and live inbox frames.
 *
 * No transport or React here — the live wiring lives in `usePendingInbox`, so
 * this logic is directly unit-testable.
 */
import { EventType, type Turn } from "@meridian/contracts/protocol";
import type { ThreadPendingInbox } from "@meridian/contracts/threads";

export const EMPTY_THREAD_PENDING_INBOX: ThreadPendingInbox = { items: [] };

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

/**
 * Writer turns the model has not read: queued behind a run, or still sending.
 * Together they are the queue a new command waits at the end of.
 */
export function unreadWriterTurnIds(
  turns: readonly Turn[],
  queued: ReadonlySet<string>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    if (turn.role === "user" && (turn.status === "pending" || queued.has(turn.id)))
      ids.add(turn.id);
  }
  return ids;
}

export function isThreadPendingInbox(value: unknown): value is ThreadPendingInbox {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Array.isArray((value as ThreadPendingInbox).items);
}

/**
 * The pending inbox from a live frame, or null when the frame is unrelated or
 * malformed. `meridian.inbox.changed` carries the full recomputed inbox, so a
 * consumer replaces its state wholesale.
 */
export function pendingInboxFromEvent(event: {
  type: string;
  name?: string;
  value?: unknown;
}): ThreadPendingInbox | null {
  if (event.type !== EventType.CUSTOM || event.name !== "meridian.inbox.changed") return null;
  return isThreadPendingInbox(event.value) ? event.value : null;
}
