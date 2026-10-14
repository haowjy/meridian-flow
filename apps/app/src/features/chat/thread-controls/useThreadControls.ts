/**
 * useThreadControls — the imperative shell around `thread-controls.ts`, and the
 * one list of queued commands the transcript shows.
 *
 * `/compact` posts from this hook: it mints the command id, shows the queued
 * row before the network answers, enqueues and withdraws through the threads
 * API, and asks the snapshot to revalidate so the new state reaches the
 * transcript. Withdraw removes the row at once and, once any in-flight enqueue
 * settles, always asks the server: an enqueue that looked failed may still
 * have landed. A 404 means the server did not have it yet: the local send
 * goes, and the row shows again if the inbox lists it later. Also stops a
 * running compaction divider through the turn cancel route, and announces each
 * state change the writer caused.
 *
 * A write-mode switch is the switch view's (`useSwitchView`): its rows,
 * Retry, Withdraw and the chat's mode come from there and are listed after the
 * compaction rows.
 */
import { t } from "@lingui/core/macro";
import type { ThreadPendingInbox } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { enqueueThreadControl, withdrawThreadControl } from "@/client/api/threads-api";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce, announceError } from "@/client/stores";
import { useTurnStop } from "../useTurnStop";
import { controlAlreadyStartedCopy, controlStatusCopy, controlStoppedCopy } from "./control-copy";
import {
  type CompactControl,
  controlsReducer,
  mergeQueuedControls,
  NO_LOCAL_CONTROLS,
  type QueuedControl,
} from "./thread-controls";
import type { SwitchView } from "./useSwitchView";

export type ThreadControls = {
  queued: readonly QueuedControl[];
  stoppingTurnIds: ReadonlySet<string>;
  /** The chat's mode as the writer should see it: the switch view's fold over the server's record. */
  writeMode: AiWriteMode;
  enqueue: (control: CompactControl) => string;
  /** Switch the chat's write mode; the row shows at once and the journal posts it in order. */
  switchWriteMode: (mode: AiWriteMode) => void;
  retry: (controlId: string) => void;
  withdraw: (control: QueuedControl) => void;
  /** Stop a running compaction divider. */
  stop: (turnId: string) => void;
};

export function useThreadControls(input: {
  threadId: string;
  pending: ThreadPendingInbox;
  answeredCompactionIds: ReadonlySet<string>;
  switches: SwitchView;
}): ThreadControls {
  const { threadId, pending, answeredCompactionIds, switches } = input;
  const [local, dispatch] = useReducer(controlsReducer, NO_LOCAL_CONTROLS);
  const localRef = useRef(local);
  localRef.current = local;
  /** In-flight enqueues; a withdrawal waits for its enqueue to settle first. */
  const inflight = useRef(new Map<string, Promise<void>>());
  const queryClient = useQueryClient();
  const turnStop = useTurnStop(threadId);

  const revalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }, [queryClient, threadId]);

  useEffect(() => {
    dispatch({ type: "listed", pendingIds: new Set(pending.items.map((item) => item.id)) });
  }, [pending]);

  const send = useCallback(
    (id: string, control: CompactControl) => {
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
          // A command the writer already withdrew has no failure to show.
          if (!localRef.current.withdrawals.has(id))
            announceError(controlStatusCopy(control, "failed"));
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
    (control: CompactControl) => {
      const id = crypto.randomUUID();
      dispatch({ type: "enqueue", id, control });
      announce(controlStatusCopy(control, "queued"));
      send(id, control);
      return id;
    },
    [send],
  );

  const { retry: retrySwitch, withdraw: withdrawSwitch } = switches;
  const retry = useCallback(
    (controlId: string) => {
      const entry = localRef.current.sends.find((candidate) => candidate.id === controlId);
      if (!entry) return retrySwitch(controlId);
      if (entry.request !== "failed") return;
      dispatch({ type: "retry", id: controlId });
      announce(controlStatusCopy(entry.control, "queued"));
      // Same id: the server treats a repeat as the original request.
      send(controlId, entry.control);
    },
    [retrySwitch, send],
  );

  const withdraw = useCallback(
    (queued: QueuedControl) => {
      if (queued.control.kind === "write_mode") return withdrawSwitch(queued);
      dispatch({ type: "withdraw", id: queued.id });
      announce(controlStoppedCopy(queued.control));
      const withdrawOnServer = async () => {
        try {
          const { outcome } = await withdrawThreadControl(threadId, queued.id);
          dispatch({ type: "withdrawn", id: queued.id });
          // The row goes either way; the divider shows a started one.
          if (outcome === "already_started") announce(controlAlreadyStartedCopy(queued.control));
          revalidate();
        } catch (error) {
          // Not there yet: the send goes, but an enqueue still committing can
          // list it later, and then the row shows again.
          if (httpErrorStatus(error) === 404) {
            return dispatch({ type: "withdraw_not_found", id: queued.id });
          }
          dispatch({ type: "withdraw_failed", id: queued.id });
          announceError(t`Couldn't stop. Try again.`);
        }
      };
      void (inflight.current.get(queued.id) ?? Promise.resolve()).then(withdrawOnServer);
    },
    [revalidate, threadId, withdrawSwitch],
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

  const compactRows = useMemo(
    () => mergeQueuedControls({ local, pending, executedControlIds: answeredCompactionIds }),
    [answeredCompactionIds, local, pending],
  );
  const queued = useMemo(() => [...compactRows, ...switches.rows], [compactRows, switches.rows]);

  return {
    queued,
    stoppingTurnIds: turnStop.stopping,
    writeMode: switches.writeMode,
    enqueue,
    switchWriteMode: switches.switchWriteMode,
    retry,
    withdraw,
    stop,
  };
}
