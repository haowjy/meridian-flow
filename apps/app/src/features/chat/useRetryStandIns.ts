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
  turn: Turn;
  request: StandInRequest;
  attempt: number;
  failure?: CommandFailure;
};

export type StandInAnswer = {
  turn: Turn | null;
  executionId: string | null;
  runState?: RunState;
};

export type RetryStandIns = {
  standIns: readonly Turn[];
  requestOf: (turnId: string) => StandInRequest | null;
  outcomes: readonly RetryOutcome[];
  retried: ReadonlySet<string>;
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

function completedReplies(turns: readonly Turn[]): ReadonlySet<string> {
  return new Set(
    turns
      .filter((turn) => turn.role === "assistant" && turn.status === "complete")
      .map((t) => t.id),
  );
}

function isRetryRefusal(error: unknown): boolean {
  return (
    httpErrorStatus(error) === 409 ||
    (error instanceof HttpResponseError && error.message === "runtime_shutting_down")
  );
}

function isRetryPending(error: unknown): boolean {
  if (httpErrorStatus(error) !== 503) return false;
  if (isMeridianApiError(error)) return error.code === REPLY_RETRY_PENDING_CODE;
  return error instanceof HttpResponseError && error.message === REPLY_RETRY_PENDING_CODE;
}

const RETRY_PENDING_DELAY_MS = 1000;
export const RETRY_PENDING_ATTEMPTS = 8;

export function useRetryStandIns(input: {
  threadId: string;
  storedTurns: readonly Turn[];
  post: (id: string, from: string) => Promise<StandInAnswer>;
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
  const sending = useMemo(() => local.filter((entry) => entry.request !== "failed"), [local]);
  const lost = useMemo(() => local.filter((entry) => entry.request === "failed"), [local]);
  const reconciled = useMemo(
    () => reconcileRetries({ entries: sending, storedTurns, view: runState, supersedes }),
    [sending, runState, storedTurns, supersedes],
  );
  useEffect(() => {
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
      retireRefusals("retried");
      const lostEntry = localRef.current.find(
        (entry) => entry.from === from.id && entry.request === "failed",
      );
      if (lostEntry) {
        if (lostEntry.failure)
          logCommandFailure(log, lostEntry.failure, { threadId, turnId: from.id }, "retried");
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
