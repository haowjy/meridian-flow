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
 * goes, and the row shows again if the inbox lists it later. Announces each
 * state change the writer caused. A running compaction divider's Stop is the
 * chat's Stop (`useChatStop`), not a command of its own.
 *
 * A write-mode switch is the switch view's (`useSwitchView`): its rows,
 * Retry, Withdraw and the chat's mode come from there and are listed after the
 * compaction rows.
 */
import type { PendingInboxItem } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { type CommandFailure, logCommandFailure, occurrenceKey } from "@meridian/thread-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { enqueueThreadControl, withdrawThreadControl } from "@/client/api/threads-api";
import { commandFailureInput } from "@/client/failures/command-failure";
import { useFailureLog } from "@/client/failures/failure-log";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce, useThreadActions } from "@/client/stores";
import { controlAlreadyStartedCopy, controlStatusCopy, controlStoppedCopy } from "./control-copy";
import {
  type CompactControl,
  type ControlAction,
  controlsReducer,
  type HeldControls,
  type LocalControls,
  mergeQueuedControls,
  NO_LOCAL_CONTROLS,
  type QueuedControl,
  reconcileControls,
} from "./thread-controls";
import type { SwitchView } from "./useSwitchView";

export type ThreadControls = {
  queued: readonly QueuedControl[];
  /** The chat's mode as the writer should see it: the switch view's fold over the server's record. */
  writeMode: AiWriteMode;
  enqueue: (control: CompactControl) => string;
  /** Switch the chat's write mode; the row shows at once and the journal posts it in order. */
  switchWriteMode: (mode: AiWriteMode) => void;
  retry: (controlId: string) => void;
  withdraw: (control: QueuedControl) => void;
};

function failuresOf(local: LocalControls): CommandFailure[] {
  return [
    ...local.sends.flatMap((e) => (e.request === "failed" && e.failure ? [e.failure] : [])),
    ...[...local.withdrawals.values()].flatMap((e) =>
      e.status === "failed" && e.failure ? [e.failure] : [],
    ),
  ];
}

export function useThreadControls(input: {
  threadId: string;
  /** The run-state record's items. */
  items: readonly PendingInboxItem[];
  /** The record's version, and the newest accepted snapshot's: what a dropped row waits on. */
  version: string | null;
  history: string | null;
  /** Every command a transcript divider names. */
  answeredControlIds: ReadonlySet<string>;
  switches: SwitchView;
}): ThreadControls {
  const { threadId, items, version, history, answeredControlIds, switches } = input;
  const held = useRef<{ threadId: string; controls: HeldControls }>({
    threadId,
    controls: new Map(),
  });
  if (held.current.threadId !== threadId) held.current = { threadId, controls: new Map() };
  const { dispatchRunState } = useThreadActions();
  const log = useFailureLog();
  const [local, renderLocal] = useState(NO_LOCAL_CONTROLS);
  const localRef = useRef(local);
  const mounted = useRef(false);
  const dispatch = useCallback(
    (action: ControlAction) => {
      const before = failuresOf(localRef.current);
      const next = controlsReducer(localRef.current, action);
      const after = failuresOf(next);
      for (const f of before)
        if (!after.some((n) => occurrenceKey(n) === occurrenceKey(f)))
          logCommandFailure(
            log,
            f,
            { threadId },
            action.type === "retry" || action.type === "withdraw"
              ? "retried"
              : action.type === "retire"
                ? "moot"
                : "resolved",
          );
      for (const f of after)
        if (!before.some((n) => occurrenceKey(n) === occurrenceKey(f)))
          logCommandFailure(log, f, { threadId });
      localRef.current = next;
      if (mounted.current) renderLocal(next);
    },
    [log, threadId],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const f of failuresOf(localRef.current)) logCommandFailure(log, f, { threadId }, "moot");
    };
  }, [log, threadId]);
  useEffect(
    () => dispatch({ type: "retire", ids: answeredControlIds }),
    [answeredControlIds, dispatch],
  );
  /** In-flight enqueues; a withdrawal waits for its enqueue to settle first. */
  const inflight = useRef(new Map<string, Promise<void>>());
  const queryClient = useQueryClient();

  const revalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }, [queryClient, threadId]);

  useEffect(() => {
    dispatch({ type: "listed", pendingIds: new Set(items.map((item) => item.id)) });
  }, [items, dispatch]);

  const send = useCallback(
    (id: string, control: CompactControl) => {
      const occurrence = {
        requestId: id,
        attempt: localRef.current.sends.find((e) => e.id === id)?.attempt ?? 1,
      };
      const request = enqueueThreadControl(threadId, { id, control }).then(
        (response) => {
          // The answer's record is a fact like any other; the command is sent if it lists it.
          dispatchRunState(threadId, { type: "snapshot", runState: response.runState });
          dispatch({
            type: "enqueued",
            id,
            sent: response.runState.items.some((item) => item.id === id),
          });
          revalidate();
        },
        (error: unknown) => {
          const failure = {
            requestId: occurrence.requestId,
            attempt: occurrence.attempt,
            ...commandFailureInput(error),
          };
          logCommandFailure(log, failure, { threadId });
          if (
            !mounted.current ||
            !localRef.current.sends.some((e) => e.id === id) ||
            localRef.current.withdrawals.has(id)
          ) {
            logCommandFailure(log, failure, { threadId }, "moot");
            return;
          }
          // The failed row is a card (`chatCards`); a command the writer already withdrew has none.
          dispatch({ type: "enqueue_failed", id, failure });
        },
      );
      inflight.current.set(id, request);
      void request.finally(() => {
        if (inflight.current.get(id) === request) inflight.current.delete(id);
      });
    },
    [dispatchRunState, revalidate, threadId, dispatch, log],
  );

  const enqueue = useCallback(
    (control: CompactControl) => {
      const id = crypto.randomUUID();
      dispatch({ type: "enqueue", id, control });
      announce(controlStatusCopy(control, "queued"));
      send(id, control);
      return id;
    },
    [send, dispatch],
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
    [retrySwitch, send, dispatch],
  );

  const withdraw = useCallback(
    (queued: QueuedControl) => {
      // The writer's own Stop is the server being told it won't run: the row goes at once.
      held.current.controls.delete(queued.id);
      if (queued.control.kind === "write_mode") return withdrawSwitch(queued);
      dispatch({ type: "withdraw", id: queued.id, requestId: crypto.randomUUID() });
      const occurrence = localRef.current.withdrawals.get(queued.id);
      announce(controlStoppedCopy(queued.control));
      const withdrawOnServer = async () => {
        try {
          const { outcome, runState } = await withdrawThreadControl(threadId, queued.id);
          dispatchRunState(threadId, { type: "snapshot", runState });
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
          if (!occurrence) return;
          const failure = {
            requestId: occurrence.requestId,
            attempt: occurrence.attempt,
            ...commandFailureInput(error),
          };
          logCommandFailure(log, failure, { threadId });
          if (!mounted.current || !localRef.current.withdrawals.has(queued.id)) {
            logCommandFailure(log, failure, { threadId }, "moot");
            return;
          }
          dispatch({ type: "withdraw_failed", id: queued.id, failure });
        }
      };
      void (inflight.current.get(queued.id) ?? Promise.resolve()).then(withdrawOnServer);
    },
    [dispatchRunState, revalidate, threadId, withdrawSwitch, dispatch, log],
  );

  const compactRows = useMemo(() => mergeQueuedControls({ local, items }), [local, items]);
  const reconciled = useMemo(
    () =>
      reconcileControls(held.current.controls, {
        rows: [...compactRows, ...switches.rows],
        answered: answeredControlIds,
        version,
        history,
      }),
    [compactRows, switches.rows, answeredControlIds, version, history],
  );
  useLayoutEffect(() => {
    held.current.controls = reconciled.held;
    dispatch({ type: "retire", ids: reconciled.retired });
  }, [reconciled, dispatch]);
  const queued = reconciled.rows;
  // A row the record dropped waits for its turn or for proof it won't run: ask for that proof.
  const droppedRows = queued.filter((row) => reconciled.held.get(row.id)?.droppedAt != null);
  const droppedKey = droppedRows.map((row) => row.id).join(",");
  useEffect(() => {
    if (droppedKey) revalidate();
  }, [droppedKey, revalidate]);

  return {
    queued,
    writeMode: switches.writeMode,
    enqueue,
    switchWriteMode: switches.switchWriteMode,
    retry,
    withdraw,
  };
}
