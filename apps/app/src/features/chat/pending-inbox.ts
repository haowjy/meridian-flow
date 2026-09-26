/**
 * Pure helpers for accepted writer-turn queue status and live inbox frames.
 *
 * No transport or React here — the live wiring lives in `usePendingInbox`, so
 * this logic is directly unit-testable.
 */
import { EventType } from "@meridian/contracts/protocol";
import type { ThreadPendingInbox } from "@meridian/contracts/threads";

export const EMPTY_THREAD_PENDING_INBOX: ThreadPendingInbox = { items: [] };

export type WriterTurnQueueStatus = "queued" | "waiting";

/** One status per accepted writer turn; inbox IDs are the persisted turn IDs. */
export function writerTurnQueueStatus(
  pending: ThreadPendingInbox,
): ReadonlyMap<string, WriterTurnQueueStatus> {
  const statuses = new Map<string, WriterTurnQueueStatus>();
  for (const item of pending.items) {
    if (item.provenance.kind !== "writer") continue;
    statuses.set(item.id, item.deliveryState === "waiting" ? "queued" : "waiting");
  }
  return statuses;
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
