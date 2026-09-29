/**
 * useReplyRetry — Retry on a failed reply.
 *
 * A failed reply consumes the messages it answered, and nothing retries it in
 * the background. Retry on the latest failed reply shows a new reply working
 * below it at once, under a client-minted id, then asks the server to answer
 * from the ordinary conversation history (`POST /turns/:turnId/retry`). The
 * failed reply stays in history above it. `useRetryStandIns` owns the stand-in,
 * the refusal note, and the re-send of a lost request.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import { retryReply } from "@/client/api/threads-api";
import { announce } from "@/client/stores";
import { type RetryStandIns, useRetryStandIns } from "./useRetryStandIns";

export type ReplyRetry = Pick<RetryStandIns, "standIns" | "requestOf" | "refused"> & {
  /** A new reply after `failed`, or the same request again when `failed` is a lost Retry. */
  retry: (failed: Turn) => void;
};

/** The new reply as the writer sees it before the server has it: working, empty. */
export function optimisticRetryReply(input: { id: string; failed: Turn; createdAt: string }): Turn {
  const { id, failed, createdAt } = input;
  return {
    id,
    threadId: failed.threadId,
    position: failed.position + 1,
    prevTurnId: failed.id,
    role: "assistant",
    origin: "assistant",
    writeMode: failed.writeMode,
    status: "pending",
    promptBakeId: null,
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    error: null,
    metadata: null,
    createdAt,
    completedAt: null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

export function useReplyRetry(input: {
  threadId: string;
  storedTurns: readonly Turn[];
}): ReplyRetry {
  const { threadId, storedTurns } = input;
  const standIns = useRetryStandIns({
    threadId,
    storedTurns,
    post: (id, from) => retryReply(threadId, from, { id }),
    lostCopy: t`Couldn't start the retry. Try again.`,
  });
  const { retry: retryStandIn } = standIns;
  const retry = useCallback(
    (failed: Turn) => {
      announce(t`Trying the response again`);
      retryStandIn(failed, ({ id }) =>
        optimisticRetryReply({ id, failed, createdAt: new Date().toISOString() }),
      );
    },
    [retryStandIn],
  );
  return {
    standIns: standIns.standIns,
    requestOf: standIns.requestOf,
    refused: standIns.refused,
    retry,
  };
}
