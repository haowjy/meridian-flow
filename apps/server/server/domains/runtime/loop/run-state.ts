import type { PendingInboxItem, RunState } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { inboxMessageText } from "./inbox-context.js";
import type { InboxMessage } from "./ports.js";

export type PendingInboxRun = { turnId: string | null; messageIds: readonly string[] } | null;

export function classifyDelivery(
  messageId: string,
  run: PendingInboxRun,
): PendingInboxItem["deliveryState"] {
  if (run === null || run.turnId === null) return "awaiting_run";
  return run.messageIds.includes(messageId) ? "awaiting_run" : "waiting";
}

export function pendingInboxItem(
  message: InboxMessage,
  deliveryState: PendingInboxItem["deliveryState"],
): PendingInboxItem {
  return {
    id: message.id,
    seq: message.seq,
    intent: message.intent,
    ...(message.body.kind === "compact" || message.body.kind === "write_mode"
      ? { control: message.body }
      : {}),
    provenance: message.provenance,
    deliveryState,
    summary: inboxMessageText(message),
    enqueuedAt: message.enqueuedAt,
  };
}

export type RunStateBody = Omit<RunState, "version">;

export type RunStateRows = {
  messages: readonly InboxMessage[];
  lease: {
    executionId: string;
    turnId: string | null;
    adoptedMessageIds: readonly string[];
  } | null;
  executionOpen: boolean;
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
