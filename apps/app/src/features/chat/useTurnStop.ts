import type { FailureEnd } from "@meridian/contracts/failures";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/protocol";
import { type CommandFailure, logCommandFailure, type Occurrence } from "@meridian/thread-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { announce } from "@/client/announcements";
import { commandFailureInput } from "@/client/failures/command-failure";
import { useFailureLog } from "@/client/failures/failure-log";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";

export type TurnStopCopy = { stopping: string };

export type TurnStop = {
  stopping: ReadonlySet<string>;
  failed: ReadonlyMap<string, Occurrence>;
  stop: (turnId: string, copy: TurnStopCopy) => void;
};

function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return set.has(id) ? set : new Set(set).add(id);
}

function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

type Failures = ReadonlyMap<string, CommandFailure>;

export function useTurnStop(threadId: string, turns: readonly Turn[]): TurnStop {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<Failures>(new Map());
  const log = useFailureLog();
  const held = useRef(failures);
  const mounted = useRef(false);
  const targets = useRef(turns);
  targets.current = turns;
  const retire = useCallback(
    (id: string, end: FailureEnd) => {
      const failure = held.current.get(id);
      if (!failure) return;
      logCommandFailure(log, failure, { threadId, turnId: id }, end);
      const next = new Map(held.current);
      next.delete(id);
      held.current = next;
      if (mounted.current) setFailures(next);
    },
    [log, threadId],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const id of held.current.keys()) retire(id, "moot");
    };
  }, [retire]);
  useEffect(() => {
    for (const id of held.current.keys())
      if (!turns.some((t) => t.id === id && !isTerminalTurnStatus(t.status))) retire(id, "moot");
  }, [turns, retire]);
  const attempts = useRef(new Map<string, number>());
  const queryClient = useQueryClient();
  const transport = useThreadTransport();

  const stop = useCallback(
    (turnId: string, copy: TurnStopCopy) => {
      const occurrence = {
        requestId: crypto.randomUUID(),
        attempt: (attempts.current.get(turnId) ?? 0) + 1,
      };
      attempts.current.set(turnId, occurrence.attempt);
      setStopping((current) => withId(current, turnId));
      retire(turnId, "retried");
      announce(copy.stopping);
      transport.cancel(threadId, turnId).then(
        () => {
          void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
        },
        (error: unknown) => {
          setStopping((current) => withoutId(current, turnId));
          const failure = { ...occurrence, ...commandFailureInput(error) };
          logCommandFailure(log, failure, { threadId, turnId });
          if (
            !mounted.current ||
            !targets.current.some((t) => t.id === turnId && !isTerminalTurnStatus(t.status))
          ) {
            logCommandFailure(log, failure, { threadId, turnId }, "moot");
            return;
          }

          const next = new Map(held.current).set(turnId, failure);
          held.current = next;
          setFailures(next);
        },
      );
    },
    [queryClient, threadId, transport, retire, log],
  );

  return { stopping, failed: failures, stop };
}
