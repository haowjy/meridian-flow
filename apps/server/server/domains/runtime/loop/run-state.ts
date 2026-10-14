/**
 * The run-state record as a pure function of rows. The Drizzle reader gathers the rows on the ambient
 * connection and the in-memory adapter shares this projection, so the record never depends on the clock.
 */
import type { RunState } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { classifyDelivery, pendingInboxItem } from "./pending-inbox.js";
import type { InboxMessage } from "./ports.js";

/** A record before it is stamped with a version. */
export type RunStateBody = Omit<RunState, "version">;

export type RunStateRows = {
  /** The chat's undelivered inbox rows, in seq order. */
  messages: readonly InboxMessage[];
  /** The chat's lease row regardless of expiry, or null. */
  lease: {
    executionId: string;
    turnId: string | null;
    adoptedMessageIds: readonly string[];
  } | null;
  /** Whether some turn carries the lease row's execution id. */
  executionOpen: boolean;
  /** `max(seq)` over the chat's writer messages, delivered ones included. */
  sentThrough: number;
  mode: AiWriteMode;
  blockedReason: "credits_exhausted" | null;
};

export function projectRunState(rows: RunStateRows): RunStateBody {
  const run = rows.lease
    ? { turnId: rows.lease.turnId, messageIds: rows.lease.adoptedMessageIds }
    : null;
  return {
    items: rows.messages
      .filter((message) => message.body.kind !== "work_context_refresh")
      .map((message) => pendingInboxItem(message, classifyDelivery(message.id, run))),
    sentThrough: rows.sentThrough,
    execution:
      rows.lease && rows.executionOpen
        ? { executionId: rows.lease.executionId, currentTurnId: rows.lease.turnId }
        : null,
    mode: rows.mode,
    blocked:
      rows.blockedReason &&
      rows.messages.some((message) => message.intent === "message" || message.intent === "control")
        ? { reason: rows.blockedReason }
        : null,
  };
}
