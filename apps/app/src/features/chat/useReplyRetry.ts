import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import { announce } from "@/client/announcements";
import { retryReply } from "@/client/api/threads-api";
import { type RetryStandIns, useRetryStandIns } from "./useRetryStandIns";

export type ReplyRetry = Pick<
  RetryStandIns,
  "standIns" | "requestOf" | "outcomes" | "retried" | "clearRefused"
> & {
  retry: (failed: Turn) => void;
};

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
    metadata: { retryOf: failed.id },
    createdAt,
    completedAt: null,
    blocks: [],
    executionId: null,
    reservedForUserTurnIds: [],
    delivery: null,
    forgottenBy: null,
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
    supersedes: true,
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
    outcomes: standIns.outcomes,
    retried: standIns.retried,
    clearRefused: standIns.clearRefused,
    retry,
  };
}
