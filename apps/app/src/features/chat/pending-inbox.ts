/**
 * Pure helpers for the pending-inbox tray: recognize the wire shape and pick it
 * out of a live frame.
 *
 * No transport or React here — the live wiring lives in `usePendingInbox`, so
 * this logic is directly unit-testable.
 */
import { EventType } from "@meridian/contracts/protocol";
import type { ThreadPendingInbox } from "@meridian/contracts/threads";

export const EMPTY_THREAD_PENDING_INBOX: ThreadPendingInbox = { items: [] };

/** Writer tray is deliberately narrower than the generic inbox/model drain. */
export function writerPendingInbox(pending: ThreadPendingInbox): ThreadPendingInbox {
  const items = pending.items.filter(
    (item) => item.provenance.kind === "writer" && item.deliveryState === "waiting",
  );
  return items.length === pending.items.length ? pending : { items };
}

/** Accepted writer turns waiting for a run, shown inline rather than in the tray. */
export function awaitingRunTurnIds(pending: ThreadPendingInbox): ReadonlySet<string> {
  return new Set(
    pending.items
      .filter((item) => item.provenance.kind === "writer" && item.deliveryState === "awaiting_run")
      .map((item) => item.id),
  );
}

export function isThreadPendingInbox(value: unknown): value is ThreadPendingInbox {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Array.isArray((value as ThreadPendingInbox).items);
}

/**
 * The pending tray from a live frame, or null when the frame is unrelated or
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
