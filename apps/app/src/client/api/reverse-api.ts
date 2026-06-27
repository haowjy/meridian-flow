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
  type JsonValue,
  type TurnReversalOutcome,
  type WriteStatus,
} from "@meridian/contracts/protocol";

import { postJson } from "./http-client";

export type ReversalDirection = "undo" | "redo";

export type WriteOutcome = {
  command: string;
  status: WriteStatus;
  isError: boolean;
  writeId?: string;
  text: string;
  content?: JsonValue[];
};

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
): Promise<WriteOutcome> {
  return postJson<WriteOutcome>(apiThreadContextReversePath(threadId), {
    scope: "turn",
    target: input.turnId,
    direction: input.direction,
    uri: input.uri,
  });
}

export function reverseTurn(
  threadId: string,
  input: ReverseTurnInput,
): Promise<TurnReversalOutcome> {
  return postJson<TurnReversalOutcome>(apiThreadContextReversePath(threadId), {
    scope: "turn",
    target: input.turnId,
    direction: input.direction,
  });
}
