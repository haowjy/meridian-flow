/**
 * useRetryStandIns — the optimistic half of a Retry that writes a new turn.
 *
 * Pressing Retry mints the new turn's id and shows its stand-in at once, then
 * asks the server to write it. The server's turn replaces the stand-in by id,
 * first from the response and then from the snapshot. A refusal (409: the chat
 * moved on first) wrote nothing: the stand-in goes, the turn the writer
 * pressed is noted, and the snapshot refreshes to show the true state. A lost
 * request keeps the stand-in, failed, and its Retry re-sends under the same
 * id: the lost request may have arrived.
 *
 * The handoff brief's Retry (`useHandoffBrief`) and a failed reply's Retry
 * (`useReplyRetry`) supply what to post and how the stand-in looks.
 */
import { t } from "@lingui/core/macro";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HttpResponseError, httpErrorStatus } from "@/client/api/http-client";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce, announceError } from "@/client/stores";
import { placeStandIns } from "./retry-stand-ins";

export type StandInRequest = "sending" | "sent" | "failed";

type StandIn = {
  /** The stand-in, then the server's turn once the response lands. */
  turn: Turn;
  request: StandInRequest;
  /** The turn whose Retry the writer pressed. */
  from: string;
};

export type RetryStandIns = {
  /** Stand-ins the store does not have yet, in the order they were asked for. */
  standIns: readonly Turn[];
  /** Where a stand-in's request is; null once the store has it, or for any other turn. */
  requestOf: (turnId: string) => StandInRequest | null;
  /** Turns whose Retry the server refused: the chat had moved on. */
  refused: ReadonlySet<string>;
  /**
   * Retry from `from`. A failed stand-in re-sends under its own id; any other
   * turn gets a new stand-in from `build`, which may decline with null.
   */
  retry: (from: Turn, build: (input: { id: string; leaf: Turn | null }) => Turn | null) => void;
};

const NO_REFUSALS: ReadonlySet<string> = new Set();

export function useRetryStandIns(input: {
  threadId: string;
  storedTurns: readonly Turn[];
  /** Ask the server for turn `id`, retrying `from` (the turn first pressed). */
  post: (id: string, from: string) => Promise<Turn>;
  /** On the failed stand-in and announced, when the request never answered. */
  lostCopy: string;
}): RetryStandIns {
  const { threadId, storedTurns } = input;
  const [local, setLocal] = useState<readonly StandIn[]>([]);
  const [refused, setRefused] = useState(NO_REFUSALS);
  const localRef = useRef(local);
  localRef.current = local;
  const storedRef = useRef(storedTurns);
  storedRef.current = storedTurns;
  // Read at call time: callers pass fresh closures and copy each render.
  const optionsRef = useRef(input);
  optionsRef.current = input;
  const queryClient = useQueryClient();

  const storedIds = useMemo(() => new Set(storedTurns.map((turn) => turn.id)), [storedTurns]);
  // Once the snapshot has the turn, it is the authority. A failed or stopped
  // compaction also settles the Retry chain that started from its predecessor.
  useEffect(() => {
    setLocal((current) => {
      const storedById = new Map(storedTurns.map((turn) => [turn.id, turn]));
      const failedCompactionSources = new Set(
        storedTurns
          .filter(
            (turn) =>
              turn.role === "compaction" &&
              turn.prevTurnId &&
              turn.status !== "complete" &&
              isTerminalTurnStatus(turn.status),
          )
          .map((turn) => turn.prevTurnId as string),
      );
      const next = current.filter((entry) => {
        if (storedIds.has(entry.turn.id)) return false;
        const predecessor = entry.turn.prevTurnId
          ? storedById.get(entry.turn.prevTurnId)
          : undefined;
        return !(
          (predecessor?.role === "compaction" &&
            predecessor.status !== "complete" &&
            isTerminalTurnStatus(predecessor.status)) ||
          failedCompactionSources.has(entry.from)
        );
      });
      return next.length === current.length ? current : next;
    });
  }, [storedIds, storedTurns]);

  const patch = useCallback((id: string, change: (entry: StandIn) => StandIn) => {
    setLocal((current) => current.map((entry) => (entry.turn.id === id ? change(entry) : entry)));
  }, []);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }, [queryClient, threadId]);

  const send = useCallback(
    (id: string, from: string) => {
      optionsRef.current.post(id, from).then(
        (serverTurn) => {
          patch(id, (entry) => ({ ...entry, turn: serverTurn, request: "sent" }));
          refresh();
        },
        (error: unknown) => {
          if (error instanceof HttpResponseError && error.message === "runtime_shutting_down") {
            setLocal((current) => current.filter((entry) => entry.turn.id !== id));
            announce(t`Couldn't retry. The server is restarting.`);
            refresh();
            return;
          }
          if (httpErrorStatus(error) === 409) {
            // Nothing was written: the snapshot shows what holds the chat, and
            // the pressed turn says Retry didn't run.
            setLocal((current) => current.filter((entry) => entry.turn.id !== id));
            setRefused((current) => new Set(current).add(from));
            announce(t`Couldn't retry. Something else started in this chat first.`);
            refresh();
            return;
          }
          const copy = optionsRef.current.lostCopy;
          announceError(copy);
          // The stand-in reads its failure from its status, as a server failure does.
          patch(id, (entry) => ({
            ...entry,
            request: "failed",
            turn: { ...entry.turn, status: "error", error: copy },
          }));
        },
      );
    },
    [patch, refresh],
  );

  const retry = useCallback<RetryStandIns["retry"]>(
    (from, build) => {
      setRefused((current) => {
        if (!current.has(from.id)) return current;
        const next = new Set(current);
        next.delete(from.id);
        return next;
      });
      const lost = localRef.current.find(
        (entry) => entry.turn.id === from.id && entry.request === "failed",
      );
      if (lost) {
        // Same id: if the lost request did reach the server, this replays it.
        patch(from.id, (entry) => ({
          ...entry,
          request: "sending",
          turn: { ...entry.turn, status: "pending", error: null },
        }));
        send(from.id, lost.from);
        return;
      }
      const id = crypto.randomUUID();
      const leaf =
        placeStandIns(
          [...storedRef.current],
          localRef.current.map((entry) => entry.turn),
        ).at(-1) ?? null;
      const standIn = build({ id, leaf });
      if (!standIn) return;
      setLocal((current) => [...current, { turn: standIn, request: "sending", from: from.id }]);
      send(id, from.id);
    },
    [patch, send],
  );

  const unstored = useMemo(
    () => local.filter((entry) => !storedIds.has(entry.turn.id)),
    [local, storedIds],
  );
  const standIns = useMemo(() => unstored.map((entry) => entry.turn), [unstored]);
  const requestOf = useCallback(
    (turnId: string) => unstored.find((entry) => entry.turn.id === turnId)?.request ?? null,
    [unstored],
  );

  return { standIns, requestOf, refused, retry };
}
