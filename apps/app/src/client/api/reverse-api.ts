/**
 * reverse-api — HTTP client for thread-scoped context undo/redo.
 *
 * Thin wrappers over the reverse endpoint used by the chat turn footer. The
 * endpoint returns semantic reversal statuses in the response body, including
 * non-error outcomes that still use HTTP 200, so callers must branch on
 * `status` rather than treating a resolved fetch as success.
 */
import {
  apiThreadContextReversePath,
  type ReversalOutcome,
  type WorkReversalResult,
} from "@meridian/contracts/protocol";

import { httpErrorStatus, postJson } from "./http-client";

/** A lost request is sent again under the same id, which the server answers once. */
const LOST_REQUEST_ATTEMPTS = 3;

export type ReversalDirection = "undo" | "redo";

export type ReverseTurnInput = {
  turnId: string;
  direction: ReversalDirection;
};

/** One click: a new command id, sent again unchanged until the server answers. */
export async function reverseTurn(
  threadId: string,
  input: ReverseTurnInput,
): Promise<ReversalOutcome> {
  const body = {
    commandId: crypto.randomUUID(),
    scope: "turn",
    target: input.turnId,
    direction: input.direction,
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return await postJson<ReversalOutcome>(apiThreadContextReversePath(threadId), body);
    } catch (cause) {
      if (httpErrorStatus(cause) !== undefined || attempt >= LOST_REQUEST_ATTEMPTS) throw cause;
    }
  }
}

/** A Work the reverse endpoint reports as put back. `name` is the writer-facing
 * Work name when the server sends one; `null` when it only sent an id. */
export function successfulWorkReversals(outcome: ReversalOutcome): WorkReversalResult[] {
  return (outcome.workReceipts ?? []).filter(
    (result) => result.status === "reversed" || result.status === "redone",
  );
}
