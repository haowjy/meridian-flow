/**
 * useThreadControls — the imperative shell around `thread-controls.ts`.
 *
 * Mints control ids, shows the queued item before the network answers,
 * enqueues and withdraws through the threads API, stops a pending divider
 * through the existing cancel route, and asks the snapshot to revalidate so a
 * divider's new state reaches the transcript. Announces each state change the
 * writer caused.
 */
import { t } from "@lingui/core/macro";
import type { ControlBody, ThreadPendingInbox } from "@meridian/contracts/threads";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { enqueueThreadControl, withdrawThreadControl } from "@/client/api/threads-api";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce, announceError } from "@/client/stores";
import {
  controlsReducer,
  type LocalControl,
  mergeQueuedControls,
  type QueuedControl,
  type WithdrawOutcome,
} from "./thread-controls";

const NO_LOCAL: readonly LocalControl[] = [];

export type ThreadControls = {
  queued: readonly QueuedControl[];
  stoppingTurnIds: ReadonlySet<string>;
  enqueue: (control: ControlBody) => string;
  retry: (controlId: string) => void;
  withdraw: (control: QueuedControl) => void;
  stop: (turnId: string) => void;
};

function queuedCopy(control: ControlBody): string {
  return control.kind === "compact"
    ? t`Compaction queued`
    : control.kind === "compaction_undo"
      ? t`Undo queued`
      : t`Handoff brief queued`;
}

function outcomeCopy(control: ControlBody, outcome: WithdrawOutcome): string {
  if (outcome === "stopping") return t`Stopping compaction`;
  if (outcome === "already_finished") return t`Already ran`;
  return control.kind === "compact"
    ? t`Compaction withdrawn`
    : control.kind === "compaction_undo"
      ? t`Undo withdrawn`
      : t`Handoff brief withdrawn`;
}

export function useThreadControls(input: {
  threadId: string;
  pending: ThreadPendingInbox;
  answeredControlIds: ReadonlySet<string>;
  leafTurnId: string | null;
}): ThreadControls {
  const { threadId, pending, answeredControlIds, leafTurnId } = input;
  const [local, dispatch] = useReducer(controlsReducer, NO_LOCAL);
  const [stoppingTurnIds, setStoppingTurnIds] = useState<ReadonlySet<string>>(() => new Set());
  const localRef = useRef(local);
  localRef.current = local;
  const leafRef = useRef(leafTurnId);
  leafRef.current = leafTurnId;
  const inflight = useRef(new Map<string, Promise<unknown>>());
  const queryClient = useQueryClient();
  const transport = useThreadTransport();

  const revalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }, [queryClient, threadId]);

  useEffect(() => {
    dispatch({ type: "observe", pendingIds: new Set(pending.items.map((item) => item.id)) });
  }, [pending]);

  const send = useCallback(
    (id: string, control: ControlBody) => {
      const request = enqueueThreadControl(threadId, { id, control }).then(
        (response) => {
          dispatch({
            type: "enqueued",
            id,
            pending: response.pending,
            turnId: response.turnId,
          });
          revalidate();
        },
        () => {
          dispatch({ type: "enqueue_failed", id });
          announceError(
            control.kind === "compaction_undo"
              ? t`Couldn't queue the undo.`
              : t`Couldn't queue the compaction.`,
          );
        },
      );
      inflight.current.set(id, request);
      void request.finally(() => {
        if (inflight.current.get(id) === request) inflight.current.delete(id);
      });
    },
    [revalidate, threadId],
  );

  const enqueue = useCallback(
    (control: ControlBody) => {
      const id = crypto.randomUUID();
      dispatch({ type: "enqueue", id, control });
      announce(queuedCopy(control));
      send(id, control);
      return id;
    },
    [send],
  );

  const retry = useCallback(
    (controlId: string) => {
      const entry = localRef.current.find((candidate) => candidate.id === controlId);
      if (entry?.request !== "failed") return;
      dispatch({ type: "retry", id: controlId });
      announce(queuedCopy(entry.control));
      // Same id: the server treats a repeat as the original request.
      send(controlId, entry.control);
    },
    [send],
  );

  const withdraw = useCallback(
    (queued: QueuedControl) => {
      dispatch({ type: "withdraw", id: queued.id, control: queued.control });
      const enqueueing = inflight.current.get(queued.id) ?? Promise.resolve();
      void enqueueing
        .then(() => withdrawThreadControl(threadId, queued.id))
        .then(
          ({ outcome }) => {
            dispatch({ type: "withdrawn", id: queued.id, outcome, leafTurnId: leafRef.current });
            announce(outcomeCopy(queued.control, outcome));
            revalidate();
          },
          () => {
            dispatch({ type: "withdraw_failed", id: queued.id });
            announceError(t`Couldn't withdraw. Try again.`);
          },
        );
    },
    [revalidate, threadId],
  );

  const stop = useCallback(
    (turnId: string) => {
      setStoppingTurnIds((current) => new Set(current).add(turnId));
      announce(t`Stopping compaction`);
      transport.cancel(threadId, turnId).then(revalidate, () => {
        setStoppingTurnIds((current) => {
          const next = new Set(current);
          next.delete(turnId);
          return next;
        });
        announceError(t`Couldn't stop the compaction. Try again.`);
      });
    },
    [revalidate, threadId, transport],
  );

  const queued = useMemo(
    () =>
      mergeQueuedControls({
        local,
        pending,
        executedControlIds: answeredControlIds,
        leafTurnId,
      }),
    [answeredControlIds, leafTurnId, local, pending],
  );

  return { queued, stoppingTurnIds, enqueue, retry, withdraw, stop };
}
