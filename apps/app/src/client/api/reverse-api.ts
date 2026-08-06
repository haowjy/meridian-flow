/**
 * reverse-api — HTTP client for thread-scoped context undo/redo.
 *
 * Thin wrappers over the reverse endpoint used by the chat turn footer. The
 * endpoint returns semantic reversal statuses in the response body, including
 * non-error outcomes that still use HTTP 200, so callers must branch on
 * `status` rather than treating a resolved fetch as success.
 */
import { apiThreadContextReversePath, type ReversalOutcome } from "@meridian/contracts/protocol";

import { postJson } from "./http-client";

export type ReversalDirection = "undo" | "redo";

export type ReverseDocumentInput = {
  turnId: string;
  uri: string;
  direction: ReversalDirection;
};

export type ReverseTurnInput = {
  turnId: string;
  direction: ReversalDirection;
};

export function reverseDocument(
  threadId: string,
  input: ReverseDocumentInput,
): Promise<ReversalOutcome> {
  return postJson<ReversalOutcome>(apiThreadContextReversePath(threadId), {
    scope: "turn",
    target: input.turnId,
    direction: input.direction,
    uri: input.uri,
  });
}

export function reverseTurn(threadId: string, input: ReverseTurnInput): Promise<ReversalOutcome> {
  return postJson<ReversalOutcome>(apiThreadContextReversePath(threadId), {
    scope: "turn",
    target: input.turnId,
    direction: input.direction,
  });
}

/** A Work the reverse endpoint reports as put back. `name` is the writer-facing
 * Work name when the server sends one; `null` when it only sent an id. */
export type RestoredWork = { name: string | null };

const RESTORED_WORK_STATUSES = new Set(["restored", "reversed", "success"]);

/**
 * The Works a reversal outcome reports as restored.
 *
 * The endpoint's Work half is newer than its document half and its wire shape
 * is still settling server-side, so every read of it funnels through this one
 * function: a field rename is a one-line fix here instead of a scavenger hunt.
 * Missing or malformed entries parse as "no Works restored", never as an error.
 */
export function restoredWorks(outcome: ReversalOutcome): RestoredWork[] {
  const carrier = outcome as unknown as Record<string, unknown>;
  const entries = carrier.workReceipts ?? carrier.works;
  if (!Array.isArray(entries)) return [];
  const restored: RestoredWork[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.status !== "string" || !RESTORED_WORK_STATUSES.has(record.status)) continue;
    const name = record.name ?? record.workName;
    restored.push({ name: typeof name === "string" && name.length > 0 ? name : null });
  }
  return restored;
}
