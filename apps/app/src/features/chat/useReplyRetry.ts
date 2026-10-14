/**
 * useReplyRetry — Retry on a failed reply.
 *
 * A failed reply consumes the messages it answered, and nothing retries it in
 * the background. Retry on the latest failed reply shows a new reply working
 * below it at once, under a client-minted id, then asks the server to answer
 * from the ordinary conversation history (`POST /turns/:turnId/retry`). The
 * failed reply is not drawn: the Retry takes its place (`viewTranscript`, from the
 * stand-in's `metadata.retryOf` and the explicit `retried` set). `useRetryStandIns` owns the stand-in,
 * the refusal note, and the re-send of a lost request.
 *
 * The request is known by its execution and the record version of its answer.
 * Once the run-state record, at or after that version, shows another execution
 * or none and the store still has no new reply, nothing will create it and the
 * stand-in goes (`retryRetired`). A lost response has no version: its stand-in
 * stays failed until the writer's Retry replays the request.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { retryRetired } from "@meridian/thread-client";
import { useCallback, useMemo } from "react";
import { retryReply } from "@/client/api/threads-api";
import { announce, useRunState } from "@/client/stores";
import { type RetryStandIns, type StandInIdentity, useRetryStandIns } from "./useRetryStandIns";

export type ReplyRetry = Pick<RetryStandIns, "standIns" | "requestOf" | "refused" | "retried"> & {
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
    // The Retry's target, carried explicitly: the transcript draws this in the failed reply's place.
    metadata: { retryOf: failed.id },
    createdAt,
    completedAt: null,
    blocks: [],
    executionId: null,
    reservedForUserTurnIds: [],
    delivery: null,
    siblingIds: [],
    responses: [],
  };
}

export function useReplyRetry(input: {
  threadId: string;
  storedTurns: readonly Turn[];
}): ReplyRetry {
  const { threadId, storedTurns } = input;
  const runState = useRunState(threadId);
  const storedIds = useMemo(() => new Set(storedTurns.map((turn) => turn.id)), [storedTurns]);
  // A reply the store has is the stand-in's to hand over to (it leaves by id); only a request
  // whose execution closed with no reply is retired here.
  const retired = useCallback(
    (standIn: StandInIdentity) =>
      standIn.answerVersion !== null &&
      !storedIds.has(standIn.id) &&
      retryRetired(runState, {
        executionId: standIn.executionId,
        answerVersion: standIn.answerVersion,
        replyTurnExists: false,
      }),
    [runState, storedIds],
  );
  const standIns = useRetryStandIns({
    threadId,
    storedTurns,
    post: (id, from) => retryReply(threadId, from, { id }),
    lostCopy: t`Couldn't start the retry. Try again.`,
    retired,
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
    refused: standIns.refused,
    retried: standIns.retried,
    retry,
  };
}
