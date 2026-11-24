import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { readHandoffSeed } from "@meridian/contracts/threads";
import type { BriefStopFailure, RetryOutcome } from "@meridian/thread-client";
import { useCallback, useMemo } from "react";
import { retryHandoffBrief } from "@/client/api/threads-api";
import { useRetryStandIns } from "../useRetryStandIns";
import { type TurnStop, useTurnStop } from "../useTurnStop";
import { isOptimisticSeed, optimisticHandoffSeed } from "./handoff-seed";

export type HandoffBrief = {
  localSeeds: readonly Turn[];
  canStop: (turn: Turn) => boolean;
  outcomes: readonly RetryOutcome[];
  stopFailures: readonly BriefStopFailure[];
  retry: (from: Turn) => void;
  stop: (turnId: string) => void;
  stopping: TurnStop["stopping"];
};

export function useHandoffBrief(input: {
  threadId: string;
  storedTurns: readonly Turn[];
}): HandoffBrief {
  const { threadId, storedTurns } = input;
  const turnStop = useTurnStop(threadId, storedTurns);
  const standIns = useRetryStandIns({
    threadId,
    storedTurns,
    post: async (id) => ({ turn: await retryHandoffBrief(threadId, { id }), executionId: null }),
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
      }),
    [stopTurn],
  );

  const stopFailures = useMemo(
    () =>
      [...turnStop.failed].map(([turnId, { requestId, attempt }]) => ({
        turnId,
        requestId,
        attempt,
      })),
    [turnStop.failed],
  );

  const canStop = useCallback(
    (turn: Turn) => !isOptimisticSeed(turn) && (requestOf(turn.id) ?? "sent") === "sent",
    [requestOf],
  );

  return useMemo(
    () => ({
      localSeeds: standIns.standIns,
      canStop,
      outcomes: standIns.outcomes,
      stopFailures,
      retry,
      stop,
      stopping: turnStop.stopping,
    }),
    [canStop, retry, standIns.outcomes, standIns.standIns, stop, stopFailures, turnStop.stopping],
  );
}
