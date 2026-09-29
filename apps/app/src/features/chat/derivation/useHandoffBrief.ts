/**
 * useHandoffBrief — Retry and Stop for a handoff destination's brief.
 *
 * The brief is not a queued command: Retry and Stop act on the seed directly.
 * Retry mints the new seed's id and shows its generating card at the leaf at
 * once, then asks the server to write it. The server's seed replaces the
 * stand-in by id, first from the response and then from the snapshot.
 *
 * A refusal (409: the chat is busy, or the brief the writer pressed is no
 * longer the latest failed one) drops the stand-in, notes it on the card the
 * writer pressed, and refreshes the snapshot so the cards show the true
 * state. A lost request keeps the stand-in, failed, and its Retry re-sends
 * under the same id: the lost request may have arrived. Stop marks the seed
 * Stopping and cancels it through the turn cancel route; a failed Stop says
 * so on the card.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { retryHandoffBrief } from "@/client/api/threads-api";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce, announceError } from "@/client/stores";
import { type TurnStop, useTurnStop } from "../useTurnStop";
import {
  isOptimisticSeed,
  optimisticHandoffSeed,
  placeLocalSeeds,
  readHandoffSeed,
} from "./handoff-seed";

type LocalSeed = {
  /** The stand-in, then the server's seed once the response lands. */
  turn: Turn;
  request: "sending" | "sent" | "failed";
  /** The card whose Retry the writer pressed. */
  from: string;
};

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

const NO_REFUSALS: ReadonlySet<string> = new Set();

export function useHandoffBrief(input: {
  threadId: string;
  storedTurns: readonly Turn[];
}): HandoffBrief {
  const { threadId, storedTurns } = input;
  const [local, setLocal] = useState<readonly LocalSeed[]>([]);
  const [retryRefused, setRetryRefused] = useState(NO_REFUSALS);
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

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }, [queryClient, threadId]);

  const send = useCallback(
    (seedId: string, from: string) => {
      retryHandoffBrief(threadId, { id: seedId }).then(
        (serverSeed) => {
          patch(seedId, (entry) => ({ ...entry, turn: serverSeed, request: "sent" }));
          refresh();
        },
        (error: unknown) => {
          if (httpErrorStatus(error) === 409) {
            // Nothing was written: the snapshot shows what holds the chat or
            // which brief is newer, and the pressed card says Retry didn't run.
            setLocal((current) => current.filter((entry) => entry.turn.id !== seedId));
            setRetryRefused((current) => new Set(current).add(from));
            announce(t`Couldn't retry. Something else started in this chat first.`);
            refresh();
            return;
          }
          const copy = t`Couldn't start a new brief. Try again.`;
          announceError(copy);
          // The card reads its failure from the seed, as it does a server failure.
          patch(seedId, (entry) => ({
            ...entry,
            request: "failed",
            turn: { ...entry.turn, status: "error", error: copy },
          }));
        },
      );
    },
    [patch, refresh, threadId],
  );

  const retry = useCallback(
    (from: Turn) => {
      setRetryRefused((current) => {
        if (!current.has(from.id)) return current;
        const next = new Set(current);
        next.delete(from.id);
        return next;
      });
      const failedRetry = localRef.current.find(
        (entry) => entry.turn.id === from.id && entry.request === "failed",
      );
      if (failedRetry) {
        // Same id: if the lost request did reach the server, this replays it.
        patch(from.id, (entry) => ({
          ...entry,
          request: "sending",
          turn: { ...entry.turn, status: "pending", error: null },
        }));
        send(from.id, failedRetry.from);
        return;
      }
      const facts = readHandoffSeed(from);
      if (!facts?.cutoffTurnId) return;
      const leaf = placeLocalSeeds(
        [...storedRef.current],
        localRef.current.map((entry) => entry.turn),
      ).at(-1);
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
      setLocal((current) => [...current, { turn: seed, request: "sending", from: from.id }]);
      send(id, from.id);
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
    retryRefused,
    retry,
    stop,
    stopping: turnStop.stopping,
    stopFailed: turnStop.failed,
  };
}
