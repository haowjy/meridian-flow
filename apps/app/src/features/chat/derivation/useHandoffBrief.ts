/**
 * useHandoffBrief — Retry and Stop for a handoff destination's brief.
 *
 * The brief is not a queued command: Retry and Stop act on the seed directly.
 * Retry mints the new seed's id and shows its generating card at the leaf at
 * once, then asks the server to write it. The server's seed replaces the
 * stand-in by id, first from the response and then from the snapshot. A
 * refusal or a lost request marks that card failed, with the reason on the
 * card, and its Retry re-sends under the same id. Stop marks the seed
 * Stopping and cancels it through the turn cancel route; a failed Stop says
 * so on the card.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HttpResponseError, isMeridianApiError } from "@/client/api/http-client";
import { retryHandoffBrief } from "@/client/api/threads-api";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { type TurnStop, useTurnStop } from "../useTurnStop";
import { isOptimisticSeed, optimisticHandoffSeed, readHandoffSeed } from "./handoff-seed";

type LocalSeed = {
  /** The stand-in, then the server's seed once the response lands. */
  turn: Turn;
  request: "sending" | "sent" | "failed";
};

export type HandoffBrief = {
  /** Retry seeds the store does not have yet, in the order they were asked for. */
  localSeeds: readonly Turn[];
  /** Whether Stop can reach this seed: the server has it. */
  canStop: (turn: Turn) => boolean;
  /** A new brief after `from`, or the same request again when `from` is a failed Retry. */
  retry: (from: Turn) => void;
  stop: (turnId: string) => void;
  stopping: TurnStop["stopping"];
  stopFailed: TurnStop["failed"];
};

function httpStatus(error: unknown): number | undefined {
  if (error instanceof HttpResponseError) return error.status;
  return isMeridianApiError(error) ? error.status : undefined;
}

function retryFailureCopy(error: unknown): string {
  // 409: the destination is replying, or another brief already started.
  return httpStatus(error) === 409
    ? t`This chat is busy. Try again when the reply finishes.`
    : t`Couldn't start a new brief. Try again.`;
}

export function useHandoffBrief(input: {
  threadId: string;
  storedTurns: readonly Turn[];
}): HandoffBrief {
  const { threadId, storedTurns } = input;
  const [local, setLocal] = useState<readonly LocalSeed[]>([]);
  const localRef = useRef(local);
  localRef.current = local;
  const storedRef = useRef(storedTurns);
  storedRef.current = storedTurns;
  const queryClient = useQueryClient();
  const turnStop = useTurnStop(threadId);

  const storedIds = useMemo(() => new Set(storedTurns.map((turn) => turn.id)), [storedTurns]);
  // Once the snapshot has a seed, it is the authority: the local copy goes.
  useEffect(() => {
    setLocal((current) => {
      const next = current.filter((entry) => !storedIds.has(entry.turn.id));
      return next.length === current.length ? current : next;
    });
  }, [storedIds]);

  const patch = useCallback((id: string, change: (entry: LocalSeed) => LocalSeed) => {
    setLocal((current) => current.map((entry) => (entry.turn.id === id ? change(entry) : entry)));
  }, []);

  const send = useCallback(
    (seedId: string) => {
      retryHandoffBrief(threadId, { id: seedId }).then(
        (serverSeed) => {
          patch(seedId, () => ({ turn: serverSeed, request: "sent" }));
          void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
        },
        (error: unknown) => {
          const copy = retryFailureCopy(error);
          // The card reads its failure from the seed, as it does a server failure.
          patch(seedId, (entry) => ({
            request: "failed",
            turn: { ...entry.turn, status: "error", error: copy },
          }));
        },
      );
    },
    [patch, queryClient, threadId],
  );

  const retry = useCallback(
    (from: Turn) => {
      const failedRetry = localRef.current.find(
        (entry) => entry.turn.id === from.id && entry.request === "failed",
      );
      if (failedRetry) {
        // Same id: if the lost request did reach the server, this replays it.
        patch(from.id, (entry) => ({
          request: "sending",
          turn: { ...entry.turn, status: "pending", error: null },
        }));
        send(from.id);
        return;
      }
      const facts = readHandoffSeed(from);
      if (!facts?.cutoffTurnId) return;
      const leaf = [...storedRef.current, ...localRef.current.map((entry) => entry.turn)].at(-1);
      const id = crypto.randomUUID();
      const seed = optimisticHandoffSeed({
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
      setLocal((current) => [...current, { turn: seed, request: "sending" }]);
      send(id);
    },
    [patch, send, threadId],
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

  const localSeeds = useMemo(
    () => local.filter((entry) => !storedIds.has(entry.turn.id)).map((entry) => entry.turn),
    [local, storedIds],
  );
  const sending = useMemo(
    () => new Set(local.filter((entry) => entry.request !== "sent").map((entry) => entry.turn.id)),
    [local],
  );
  const canStop = useCallback(
    (turn: Turn) => !isOptimisticSeed(turn) && !sending.has(turn.id),
    [sending],
  );

  return {
    localSeeds,
    canStop,
    retry,
    stop,
    stopping: turnStop.stopping,
    stopFailed: turnStop.failed,
  };
}
