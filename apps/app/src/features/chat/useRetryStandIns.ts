/**
 * useRetryStandIns — the optimistic half of a Retry that writes a new turn.
 *
 * Pressing Retry mints the new turn's id and shows its stand-in at once, then
 * asks the server to write it. The server's turn replaces the stand-in by id,
 * first from the response and then from the snapshot. A refusal (409: the chat
 * moved on first; or the server is shutting down) wrote nothing: the stand-in
 * goes and the snapshot refreshes to show the true state. The refusal is a fact this hook
 * holds (`outcomes`); `chatCards` makes it the temporary "Couldn't retry." card on the pressed
 * turn. It clears at the writer's next Retry or send, or when a reply completes that wasn't
 * complete at the refusal (read from the stored turns' status; a reply that fails or is
 * cancelled leaves it). A lost request is the same kind of fact: the entry is kept, failed,
 * but is no stand-in (the pressed turn shows again, with a "Couldn't start the retry." card),
 * and Try again re-sends under the same id: the lost request may have arrived. The server
 * answers that replay with the execution the first request started, or `retry_pending` (503)
 * while it can't tell yet: the same id goes again after the server's `Retry-After`, a bounded
 * number of times, then waits for the writer's Try again like a lost request.
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

import type { FailureEnd } from "@meridian/contracts/failures";
import { REPLY_RETRY_PENDING_CODE, type Turn } from "@meridian/contracts/protocol";
import type { RunState } from "@meridian/contracts/threads";
import {
  type CommandFailure,
  logCommandFailure,
  placeStandIns,
  type RetryEntry,
  type RetryOutcome,
  type RetryRefusal,
  reconcileRetries,
} from "@meridian/thread-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HttpResponseError, httpErrorStatus, retryAfterMs } from "@/client/api/http-client";
import { isMeridianApiError } from "@/client/api/meridian-error";
import { commandFailureInput } from "@/client/failures/command-failure";
import { useFailureLog } from "@/client/failures/failure-log";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { useRunState, useThreadActions } from "@/client/stores";

export type StandInRequest = "sending" | "sent" | "failed";

type StandIn = RetryEntry & {
  /** The stand-in, then the server's turn once the response lands. */
  turn: Turn;
  request: StandInRequest;
  /** Writer presses of this request: the card's occurrence (`${id}:${attempt}`). */
  attempt: number;
  failure?: CommandFailure;
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
  /**
   * Retries that did not start a reply, for `chatCards`: a refusal (nothing was written, and no
   * reply has completed since) or a lost request (Try again re-sends it).
   */
  outcomes: readonly RetryOutcome[];
  /**
   * Failed replies whose Retry is pending or accepted but no stored turn names it yet
   * (`metadata.retryOf`): `viewTranscript` leaves them out, so the Retry stands in their place.
   */
  retried: ReadonlySet<string>;
  /**
   * Retry from `from`. A failed stand-in re-sends under its own id; any other
   * turn gets a new stand-in from `build`, which may decline with null.
   */
  /** The writer acted elsewhere (sent a message): their refusals are answered, so they clear. */
  clearRefused: () => void;
  retry: (from: Turn, build: (input: { id: string; leaf: Turn | null }) => Turn | null) => void;
};

type Refusal = {
  failure: CommandFailure;
  before: ReadonlySet<string>;
  cause: RetryRefusal;
  id: string;
  attempt: number;
};

const NO_REFUSALS: ReadonlyMap<string, Refusal> = new Map();

/** Ids of the replies already complete: a refusal is answered by one that isn't in this set. */
function completedReplies(turns: readonly Turn[]): ReadonlySet<string> {
  return new Set(
    turns
      .filter((turn) => turn.role === "assistant" && turn.status === "complete")
      .map((t) => t.id),
  );
}

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
  /**
   * The Retry replaces the turn it retries in the transcript (a failed reply's Retry), so the
   * pressed turn stays out of view while the Retry is pending and until a stored turn carries
   * `metadata.retryOf` for it. Not for a handoff brief's Retry.
   */
  supersedes?: boolean;
}): RetryStandIns {
  const { supersedes = false } = input;
  const { threadId, storedTurns } = input;
  const log = useFailureLog();
  const [local, renderLocal] = useState<readonly StandIn[]>([]);
  const localRef = useRef(local);
  const setLocal = useCallback((change: (current: readonly StandIn[]) => readonly StandIn[]) => {
    localRef.current = change(localRef.current);
    renderLocal(localRef.current);
  }, []);
  // Refused turn → the replies complete when it was refused. The refusal is temporary: it ends
  // when a reply completes that is not in that set (durable turn status, not timers).
  const [refusals, renderRefusals] = useState(NO_REFUSALS);
  const refusalsRef = useRef(refusals);
  const setRefusals = useCallback(
    (change: (current: ReadonlyMap<string, Refusal>) => ReadonlyMap<string, Refusal>) => {
      refusalsRef.current = change(refusalsRef.current);
      renderRefusals(refusalsRef.current);
    },
    [],
  );
  const retireRefusals = useCallback(
    (end: FailureEnd) => {
      for (const [turnId, refusal] of refusalsRef.current)
        logCommandFailure(log, refusal.failure, { threadId, turnId }, end);
      setRefusals(() => NO_REFUSALS);
    },
    [log, threadId, setRefusals],
  );
  const refused = useMemo<readonly RetryOutcome[]>(
    () =>
      [...refusals].map(([turnId, { cause, id, attempt }]) => ({
        kind: "refused",
        turnId,
        requestId: id,
        attempt,
        cause,
      })),
    [refusals],
  );
  useEffect(() => {
    const next = new Map(refusalsRef.current);
    for (const [turnId, r] of next) {
      const removed = !storedTurns.some((t) => t.id === turnId);
      const answered = storedTurns.some(
        (t) => t.role === "assistant" && t.status === "complete" && !r.before.has(t.id),
      );
      if (removed || answered) {
        logCommandFailure(log, r.failure, { threadId, turnId }, removed ? "moot" : "moved_on");
        next.delete(turnId);
      }
    }
    if (next.size !== refusalsRef.current.size) setRefusals(() => next);
  }, [storedTurns, log, threadId, setRefusals]);
  const storedRef = useRef(storedTurns);
  // Read at call time: callers pass fresh closures and copy each render.
  const optionsRef = useRef(input);
  useLayoutEffect(() => {
    storedRef.current = storedTurns;
    optionsRef.current = input;
  }, [input, local, storedTurns]);
  const queryClient = useQueryClient();
  const { dispatchRunState } = useThreadActions();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const e of localRef.current)
        if (e.failure) logCommandFailure(log, e.failure, { threadId, turnId: e.from }, "moot");
      for (const [turnId, r] of refusalsRef.current)
        logCommandFailure(log, r.failure, { threadId, turnId }, "moot");
    };
  }, [log, threadId]);

  const runState = useRunState(threadId);
  // A lost request is no stand-in: it hides nothing and draws nothing, and waits for Try again.
  const sending = useMemo(() => local.filter((entry) => entry.request !== "failed"), [local]);
  const lost = useMemo(() => local.filter((entry) => entry.request === "failed"), [local]);
  const reconciled = useMemo(
    () => reconcileRetries({ entries: sending, storedTurns, view: runState, supersedes }),
    [sending, runState, storedTurns, supersedes],
  );
  useEffect(() => {
    // A lost request the store now has by id did land: it is a stored turn's story, not a failure.
    const stored = new Set(storedTurns.map((turn) => turn.id));
    const landed = lost.some((entry) => stored.has(entry.id) || !stored.has(entry.from));
    for (const entry of lost)
      if (entry.failure && (stored.has(entry.id) || !stored.has(entry.from)))
        logCommandFailure(
          log,
          entry.failure,
          { threadId, turnId: entry.from },
          stored.has(entry.id) ? "resolved" : "moot",
        );
    if (reconciled.remaining === sending && !landed) return;
    const keep = new Set(reconciled.remaining.map((entry) => entry.id));
    setLocal((current) =>
      current.filter((entry) =>
        entry.request === "failed"
          ? !stored.has(entry.id) && stored.has(entry.from)
          : keep.has(entry.id),
      ),
    );
  }, [lost, reconciled.remaining, sending, storedTurns, log, threadId, setLocal]);

  const patch = useCallback(
    (id: string, change: (entry: StandIn) => StandIn) => {
      setLocal((current) => current.map((entry) => (entry.turn.id === id ? change(entry) : entry)));
    },
    [setLocal],
  );

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }, [queryClient, threadId]);

  const send = useCallback(
    (id: string, from: string, pressAttempt = 1, attempt = 1) => {
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
          if (mounted.current && isRetryPending(error) && attempt < RETRY_PENDING_ATTEMPTS) {
            setTimeout(() => {
              if (mounted.current && localRef.current.some((entry) => entry.turn.id === id))
                sendRef.current(id, from, pressAttempt, attempt + 1);
            }, retryAfterMs(error) ?? RETRY_PENDING_DELAY_MS);
            return;
          }
          const failure: CommandFailure = {
            requestId: id,
            attempt: pressAttempt,
            ...commandFailureInput(error),
          };
          logCommandFailure(log, failure, { threadId, turnId: from });
          if (!mounted.current || !storedRef.current.some((t) => t.id === from)) {
            logCommandFailure(log, failure, { threadId, turnId: from }, "moot");
            return;
          }
          if (storedRef.current.some((t) => t.id === id)) {
            logCommandFailure(log, failure, { threadId, turnId: from }, "resolved");
            return;
          }
          // A refusal (409: the chat moved on first; or the server is shutting
          // down) wrote nothing. The writer sees one generic line; the cause
          // goes to diagnostics.
          if (isRetryRefusal(error)) {
            const attempt = pressAttempt;
            setLocal((current) => current.filter((entry) => entry.turn.id !== id));
            setRefusals((current) =>
              new Map(current).set(from, {
                failure,
                before: completedReplies(storedRef.current),
                cause: httpErrorStatus(error) === 409 ? "another-reply" : "other",
                id,
                attempt,
              }),
            );
            refresh();
            return;
          }
          // Lost: the failure is a fact `chatCards` turns into a card on the pressed turn.
          patch(id, (entry) => ({ ...entry, request: "failed", failure }));
        },
      );
    },
    [dispatchRunState, patch, refresh, threadId, log, setLocal, setRefusals],
  );
  const sendRef = useRef(send);
  useLayoutEffect(() => {
    sendRef.current = send;
  }, [send]);

  const retry = useCallback<RetryStandIns["retry"]>(
    (from, build) => {
      // One clearing rule: any next action of the writer drops every "Couldn't retry." card.
      retireRefusals("retried");
      const lostEntry = localRef.current.find(
        (entry) => entry.from === from.id && entry.request === "failed",
      );
      if (lostEntry) {
        if (lostEntry.failure)
          logCommandFailure(log, lostEntry.failure, { threadId, turnId: from.id }, "retried");
        // Same id: if the lost request did reach the server, this replays it.
        patch(lostEntry.turn.id, (entry) => ({
          ...entry,
          request: "sending",
          attempt: entry.attempt + 1,
          failure: undefined,
        }));
        send(lostEntry.turn.id, lostEntry.from, lostEntry.attempt + 1);
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
          attempt: 1,
        },
      ]);
      send(id, from.id);
    },
    [patch, send, log, threadId, retireRefusals, setLocal],
  );

  const clearRefused = useCallback(() => retireRefusals("moved_on"), [retireRefusals]);

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
  const outcomes = useMemo<readonly RetryOutcome[]>(
    () => [
      ...refused,
      ...lost.map(
        (entry): RetryOutcome => ({
          kind: "lost",
          turnId: entry.from,
          requestId: entry.id,
          attempt: entry.attempt,
        }),
      ),
    ],
    [lost, refused],
  );

  return { standIns, requestOf, outcomes, retried, clearRefused, retry };
}
