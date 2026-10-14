/**
 * useRetryStandIns — the optimistic half of a Retry that writes a new turn.
 *
 * Pressing Retry mints the new turn's id and shows its stand-in at once, then
 * asks the server to write it. The server's turn replaces the stand-in by id,
 * first from the response and then from the snapshot. A refusal (409: the chat
 * moved on first; or the server is shutting down) wrote nothing: the stand-in
 * goes, the turn the writer pressed is noted with a generic "Couldn't retry.",
 * and the snapshot refreshes to show the true state. A lost
 * request keeps the stand-in, failed, and its Retry re-sends under the same
 * id: the lost request may have arrived. The server answers that replay with
 * the execution the first request started, or `retry_pending` (503) while it
 * can't tell yet: the same id goes again after the server's `Retry-After`, a
 * bounded number of times, then waits for the writer's Retry like a lost request.
 *
 * Which entries remain, which stand in as turns and which failed replies they hide is the
 * package's one decision (`reconcileRetries`): a stand-in whose reservation ended without
 * creating its turn (a Retry whose compaction was stopped) is retired by the run-state record at
 * or after its answer's version. A request whose answer never arrived has no version to read,
 * so its failed stand-in waits for the writer's Retry, which replays it. This hook keeps
 * transport and storage.
 *
 * The handoff brief's Retry (`useHandoffBrief`) and a failed reply's Retry
 * (`useReplyRetry`) supply what to post and how the stand-in looks.
 */
import { t } from "@lingui/core/macro";
import { REPLY_RETRY_PENDING_CODE, type Turn } from "@meridian/contracts/protocol";
import type { RunState } from "@meridian/contracts/threads";
import { placeStandIns, type RetryEntry, reconcileRetries } from "@meridian/thread-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HttpResponseError, httpErrorStatus, retryAfterMs } from "@/client/api/http-client";
import { isMeridianApiError } from "@/client/api/meridian-error";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce, announceError, useRunState, useThreadActions } from "@/client/stores";
import { reportRetryRefused } from "./error-telemetry";

export type StandInRequest = "sending" | "sent" | "failed";

type StandIn = RetryEntry & {
  /** The stand-in, then the server's turn once the response lands. */
  turn: Turn;
  request: StandInRequest;
};

/**
 * What the server answered: the new turn when it has one, the execution answering it, and the
 * record after the request (none for a request that holds no execution).
 */
export type StandInAnswer = {
  turn: Turn | null;
  executionId: string | null;
  runState?: RunState;
};

export type RetryStandIns = {
  /** Stand-ins the store does not have yet, in the order they were asked for. */
  standIns: readonly Turn[];
  /** Where a stand-in's request is; null once the store has it, or for any other turn. */
  requestOf: (turnId: string) => StandInRequest | null;
  /** Turns whose Retry the server refused; nothing was written. */
  refused: ReadonlySet<string>;
  /**
   * Failed replies whose Retry is pending or accepted but no stored turn names it yet
   * (`metadata.retryOf`): `viewTranscript` leaves them out, so the Retry stands in their place.
   */
  retried: ReadonlySet<string>;
  /**
   * Retry from `from`. A failed stand-in re-sends under its own id; any other
   * turn gets a new stand-in from `build`, which may decline with null.
   */
  /** The writer acted elsewhere (sent a message): refusals are answered, so they clear. */
  clearRefused: () => void;
  retry: (from: Turn, build: (input: { id: string; leaf: Turn | null }) => Turn | null) => void;
};

const NO_REFUSALS: ReadonlySet<string> = new Set();

/** The server answered and wrote nothing: the chat moved on, or it is shutting down. */
function isRetryRefusal(error: unknown): boolean {
  return (
    httpErrorStatus(error) === 409 ||
    (error instanceof HttpResponseError && error.message === "runtime_shutting_down")
  );
}

/** The server can't tell yet whether this replay is its own first request: ask again. */
function isRetryPending(error: unknown): boolean {
  if (httpErrorStatus(error) !== 503) return false;
  if (isMeridianApiError(error)) return error.code === REPLY_RETRY_PENDING_CODE;
  return error instanceof HttpResponseError && error.message === REPLY_RETRY_PENDING_CODE;
}

/** The wait when a `retry_pending` answer carries no usable `Retry-After`. */
const RETRY_PENDING_DELAY_MS = 1000;
/** Automatic sends per writer press while the server answers `retry_pending`. */
export const RETRY_PENDING_ATTEMPTS = 8;

export function useRetryStandIns(input: {
  threadId: string;
  storedTurns: readonly Turn[];
  /**
   * Ask the server for turn `id`, retrying `from` (the turn first pressed).
   * A null turn: accepted, but the server has no turn to show yet.
   */
  post: (id: string, from: string) => Promise<StandInAnswer>;
  /** On the failed stand-in and announced, when the request never answered. */
  lostCopy: string;
  /**
   * The Retry replaces the turn it retries in the transcript (a failed reply's Retry), so the
   * pressed turn stays out of view while the Retry is pending and until a stored turn carries
   * `metadata.retryOf` for it. Not for a handoff brief's Retry.
   */
  supersedes?: boolean;
}): RetryStandIns {
  const { supersedes = false } = input;
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
  const { dispatchRunState } = useThreadActions();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const runState = useRunState(threadId);
  const reconciled = useMemo(
    () => reconcileRetries({ entries: local, storedTurns, view: runState, supersedes }),
    [local, runState, storedTurns, supersedes],
  );
  useEffect(() => {
    if (reconciled.remaining !== local) setLocal([...reconciled.remaining]);
  }, [local, reconciled.remaining]);

  const patch = useCallback((id: string, change: (entry: StandIn) => StandIn) => {
    setLocal((current) => current.map((entry) => (entry.turn.id === id ? change(entry) : entry)));
  }, []);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }, [queryClient, threadId]);

  const send = useCallback(
    (id: string, from: string, attempt = 1) => {
      optionsRef.current.post(id, from).then(
        (answer) => {
          // The answer's record is a fact like any other.
          if (answer.runState)
            dispatchRunState(threadId, { type: "snapshot", runState: answer.runState });
          patch(id, (entry) => ({
            ...entry,
            turn: answer.turn ?? entry.turn,
            executionId: answer.executionId ?? entry.executionId,
            answerVersion: answer.runState?.version ?? entry.answerVersion,
            request: "sent",
          }));
          refresh();
        },
        (error: unknown) => {
          // Still undecided: the same id again after the server's wait, while
          // the budget lasts. Past it the request stays unresolved, never refused.
          if (isRetryPending(error) && attempt < RETRY_PENDING_ATTEMPTS) {
            setTimeout(() => {
              if (mounted.current && localRef.current.some((entry) => entry.turn.id === id))
                sendRef.current(id, from, attempt + 1);
            }, retryAfterMs(error) ?? RETRY_PENDING_DELAY_MS);
            return;
          }
          // A refusal (409: the chat moved on first; or the server is shutting
          // down) wrote nothing. The writer sees one generic line; the cause
          // goes to diagnostics.
          if (isRetryRefusal(error)) {
            reportRetryRefused({ threadId, from, status: httpErrorStatus(error), error });
            setLocal((current) => current.filter((entry) => entry.turn.id !== id));
            setRefused((current) => new Set(current).add(from));
            announce(t`Couldn't retry.`);
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
    [dispatchRunState, patch, refresh, threadId],
  );
  const sendRef = useRef(send);
  sendRef.current = send;

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
      setLocal((current) => [
        ...current,
        {
          id: standIn.id,
          turn: standIn,
          request: "sending",
          from: from.id,
          executionId: null,
          answerVersion: null,
        },
      ]);
      send(id, from.id);
    },
    [patch, send],
  );

  const clearRefused = useCallback(() => setRefused(NO_REFUSALS), []);

  const standIns = useMemo(
    () => reconciled.standIns.map((entry) => entry.turn),
    [reconciled.standIns],
  );
  const requestOf = useCallback(
    (turnId: string) =>
      reconciled.standIns.find((entry) => entry.turn.id === turnId)?.request ?? null,
    [reconciled.standIns],
  );
  const retried = reconciled.hidden;

  return { standIns, requestOf, refused, retried, clearRefused, retry };
}
