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
 * The request is known by its execution (from the response) or, when the
 * response was lost, by the reservation that records its id
 * (`metadata.retryReplyId`). Once that execution has ended without the new
 * reply, nothing will create it and the stand-in goes.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import { retryReply } from "@/client/api/threads-api";
import type { RunFacts } from "@/client/copilot/run-follow";
import { announce } from "@/client/stores";
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

function retryReplyIdOf(turn: Turn): string | null {
  const { metadata } = turn;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const id = (metadata as { retryReplyId?: unknown }).retryReplyId;
  return typeof id === "string" ? id : null;
}

/**
 * Whether a Retry request's reservation ended without creating its reply: its
 * execution (answered, or read off the turn that records the request id) has
 * ended, and no turn of it is the requested reply.
 */
export function retryReservationEnded(
  standIn: StandInIdentity,
  storedTurns: readonly Turn[],
  facts: RunFacts,
): boolean {
  const executionId =
    standIn.executionId ??
    storedTurns.find((turn) => retryReplyIdOf(turn) === standIn.id)?.executionId ??
    null;
  if (executionId === null || !facts.ended.has(executionId)) return false;
  return facts.turns.get(standIn.id)?.executionId !== executionId;
}

export function useReplyRetry(input: {
  threadId: string;
  storedTurns: readonly Turn[];
  /** The thread's merged run identity facts; a new value retires stand-ins whose execution ended. */
  runFacts: RunFacts;
}): ReplyRetry {
  const { threadId, storedTurns, runFacts } = input;
  const retired = useCallback(
    (standIn: StandInIdentity) => retryReservationEnded(standIn, storedTurns, runFacts),
    [runFacts, storedTurns],
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
