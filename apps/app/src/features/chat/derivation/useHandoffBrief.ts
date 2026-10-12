/**
 * useHandoffBrief — Retry and Stop for a handoff destination's brief.
 *
 * The brief is not a queued command: Retry and Stop act on the seed directly.
 * Retry shows the new seed's generating card at the leaf at once and asks the
 * server to write it (`useRetryStandIns` owns the stand-in, the refusal note,
 * and the re-send of a lost request). Stop marks the seed Stopping and cancels
 * it through the turn cancel route; a failed Stop says so on the card.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import { retryHandoffBrief } from "@/client/api/threads-api";
import { useRetryStandIns } from "../useRetryStandIns";
import { type TurnStop, useTurnStop } from "../useTurnStop";
import { isOptimisticSeed, optimisticHandoffSeed, readHandoffSeed } from "./handoff-seed";

export type HandoffBrief = {
  /** Retry seeds the store does not have yet, in the order they were asked for. */
  localSeeds: readonly Turn[];
  /** Whether Stop can reach this seed: the server has it. */
  canStop: (turn: Turn) => boolean;
  /** Cards whose Retry the server refused: the chat had moved on. */
  retryRefused: ReadonlySet<string>;
  /** A new brief after `from`, or the same request again when `from` is a failed Retry. */
  retry: (from: Turn) => void;
  stop: (turnId: string) => void;
  stopping: TurnStop["stopping"];
  stopFailed: TurnStop["failed"];
};

export function useHandoffBrief(input: {
  threadId: string;
  storedTurns: readonly Turn[];
}): HandoffBrief {
  const { threadId, storedTurns } = input;
  const turnStop = useTurnStop(threadId);
  const standIns = useRetryStandIns({
    threadId,
    storedTurns,
    post: (id) => retryHandoffBrief(threadId, { id }),
    lostCopy: t`Couldn't start a new brief. Try again.`,
  });

  const { retry: retryStandIn, requestOf } = standIns;
  const retry = useCallback(
    (from: Turn) =>
      retryStandIn(from, ({ id, leaf }) => {
        const facts = readHandoffSeed(from);
        if (!facts?.cutoffTurnId) return null;
        return optimisticHandoffSeed({
          id,
          threadId,
          position: (leaf?.position ?? 0) + 1,
          prevTurnId: leaf?.id ?? null,
          sourceThreadId: facts.sourceThreadId,
          sourceRef: facts.sourceRef,
          sourceTitle: facts.sourceTitle,
          cutoffTurnId: facts.cutoffTurnId,
          createdAt: new Date().toISOString(),
        });
      }),
    [retryStandIn, threadId],
  );

  const { stop: stopTurn } = turnStop;
  const stop = useCallback(
    (turnId: string) =>
      stopTurn(turnId, {
        stopping: t`Stopping the handoff brief`,
        failed: t`Couldn't stop the brief. Try again.`,
      }),
    [stopTurn],
  );

  // Only what the server has can be stopped: not the opening stand-in, and
  // not a Retry whose request hasn't answered.
  const canStop = useCallback(
    (turn: Turn) => !isOptimisticSeed(turn) && (requestOf(turn.id) ?? "sent") === "sent",
    [requestOf],
  );

  return {
    localSeeds: standIns.standIns,
    canStop,
    retryRefused: standIns.refused,
    retry,
    stop,
    stopping: turnStop.stopping,
    stopFailed: turnStop.failed,
  };
}
