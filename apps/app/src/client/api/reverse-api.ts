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
