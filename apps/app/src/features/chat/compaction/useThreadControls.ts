/**
 * useThreadControls — the imperative shell around `thread-controls.ts`.
 *
 * Mints command ids, shows the queued row before the network answers,
 * enqueues and withdraws through the threads API, and asks the snapshot to
 * revalidate so the new state reaches the transcript. Withdraw removes the row
 * at once; a command the server never took (its enqueue failed) is withdrawn
 * locally, with no request. Also stops a running compaction divider through the turn cancel
 * route. Announces each state change the writer caused.
 */
import { t } from "@lingui/core/macro";
import type { ControlBody, ThreadPendingInbox } from "@meridian/contracts/threads";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { enqueueThreadControl, withdrawThreadControl } from "@/client/api/threads-api";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce, announceError } from "@/client/stores";
import { useTurnStop } from "../useTurnStop";
import { controlStatusCopy, controlWithdrawnCopy } from "./control-copy";
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
  /** Stop a running compaction divider. */
  stop: (turnId: string) => void;
};

export function useThreadControls(input: {
  threadId: string;
  pending: ThreadPendingInbox;
  answeredControlIds: ReadonlySet<string>;
  leafTurnId: string | null;
  /** The newest writer turn still waiting to be read: a new command queues after it. */
  queueTailTurnId: string | null;
}): ThreadControls {
  const { threadId, pending, answeredControlIds, leafTurnId, queueTailTurnId } = input;
  const [local, dispatch] = useReducer(controlsReducer, NO_LOCAL);
  const localRef = useRef(local);
  localRef.current = local;
  const leafRef = useRef(leafTurnId);
  leafRef.current = leafTurnId;
  const queueTailRef = useRef(queueTailTurnId);
  queueTailRef.current = queueTailTurnId;
  /** In-flight enqueues, resolving to whether the server took the command. */
  const inflight = useRef(new Map<string, Promise<boolean>>());
  const queryClient = useQueryClient();
  const turnStop = useTurnStop(threadId);

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
          return true;
        },
        () => {
          dispatch({ type: "enqueue_failed", id });
          // A command the writer already withdrew has no failure to show.
          const entry = localRef.current.find((candidate) => candidate.id === id);
          if (entry?.withdrawal !== "withdrawing") announceError(controlStatusCopy("failed"));
          return false;
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
      dispatch({ type: "enqueue", id, control, afterTurnId: queueTailRef.current });
      announce(controlStatusCopy("queued"));
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
      announce(controlStatusCopy("queued"));
      // Same id: the server treats a repeat as the original request.
      send(controlId, entry.control);
    },
    [send],
  );

  const withdraw = useCallback(
    (queued: QueuedControl) => {
      dispatch({ type: "withdraw", id: queued.id, control: queued.control });
      announce(controlWithdrawnCopy());
      const settle = (outcome: WithdrawOutcome) =>
        dispatch({ type: "withdrawn", id: queued.id, outcome, leafTurnId: leafRef.current });
      const enqueueing =
        inflight.current.get(queued.id) ?? Promise.resolve(queued.status !== "failed");
      void enqueueing.then(async (accepted) => {
        // The server never took it: there is nothing there to withdraw.
        if (!accepted) return settle("withdrawn");
        try {
          const { outcome } = await withdrawThreadControl(threadId, queued.id);
          settle(outcome);
          if (outcome === "already_started") announce(controlStatusCopy("already_started"));
          revalidate();
        } catch (error) {
          // A 404 on an id the inbox never listed: its enqueue never landed.
          const seen = localRef.current.find((entry) => entry.id === queued.id)?.seen ?? true;
          if (httpErrorStatus(error) === 404 && !seen) return settle("withdrawn");
          dispatch({ type: "withdraw_failed", id: queued.id });
          announceError(t`Couldn't withdraw. Try again.`);
        }
      });
    },
    [revalidate, threadId],
  );

  const { stop: stopTurn } = turnStop;
  const stop = useCallback(
    (turnId: string) =>
      stopTurn(turnId, {
        stopping: t`Stopping compaction`,
        failed: t`Couldn't stop the compaction. Try again.`,
      }),
    [stopTurn],
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

  return { queued, stoppingTurnIds: turnStop.stopping, enqueue, retry, withdraw, stop };
}
