import type { PendingInboxItem } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { logCommandFailure, occurrenceKey } from "@meridian/thread-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { enqueueThreadControl, withdrawThreadControl } from "@/client/api/threads-api";
import { commandFailureInput } from "@/client/failures/command-failure";
import { useFailureLog } from "@/client/failures/failure-log";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce, useThreadActions } from "@/client/stores";
import { controlAlreadyStartedCopy, controlStatusCopy, controlWithdrawnCopy } from "./control-copy";
import {
  type CompactControl,
  type ControlAction,
  type ControlFacts,
  controlFailures,
  controlsReducer,
  NO_LOCAL_CONTROLS,
  type QueuedControl,
  queuedControls,
} from "./thread-controls";
import type { SwitchView } from "./useSwitchView";

export type ThreadControls = {
  queued: readonly QueuedControl[];
  writeMode: AiWriteMode;
  enqueue: (control: CompactControl) => string;
  switchWriteMode: (mode: AiWriteMode) => void;
  retry: (controlId: string) => void;
  withdraw: (control: QueuedControl) => void;
};

export function useThreadControls(input: {
  threadId: string;
  items: readonly PendingInboxItem[];
  version: string | null;
  history: string | null;
  answeredControlIds: ReadonlySet<string>;
  switches: SwitchView;
}): ThreadControls {
  const { threadId, items, version, history, answeredControlIds, switches } = input;
  const facts = useRef<ControlFacts>({
    items,
    switches: switches.rows,
    answered: answeredControlIds,
    version,
    history,
  });
  const { dispatchRunState } = useThreadActions();
  const log = useFailureLog();
  const [local, renderLocal] = useState(NO_LOCAL_CONTROLS);
  const localRef = useRef(local);
  const mounted = useRef(false);
  const dispatch = useCallback(
    (action: ControlAction) => {
      const before = controlFailures(localRef.current);
      const changed = controlsReducer(localRef.current, action);
      const next =
        action.type === "reconcile" || action.type === "hide_switch"
          ? changed
          : controlsReducer(changed, { type: "reconcile", facts: facts.current });
      const after = controlFailures(next);
      for (const f of before)
        if (!after.some((n) => occurrenceKey(n) === occurrenceKey(f)))
          logCommandFailure(
            log,
            f,
            { threadId },
            action.type === "retry" || action.type === "withdraw"
              ? "retried"
              : action.type === "reconcile"
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
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const f of controlFailures(localRef.current))
        logCommandFailure(log, f, { threadId }, "moot");
    };
  }, [log, threadId]);
  useLayoutEffect(() => {
    facts.current = {
      items,
      switches: switches.rows,
      answered: answeredControlIds,
      version,
      history,
    };
    dispatch({ type: "reconcile", facts: facts.current });
  }, [items, switches.rows, answeredControlIds, version, history, dispatch]);
  const inflight = useRef(new Map<string, Promise<void>>());
  const queryClient = useQueryClient();

  const revalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }, [queryClient, threadId]);

  const send = useCallback(
    (id: string, control: CompactControl) => {
      const occurrence = {
        requestId: id,
        attempt: localRef.current.get(id)?.send?.attempt ?? 1,
      };
      const request = enqueueThreadControl(threadId, { id, control }).then(
        (response) => {
          dispatchRunState(threadId, { type: "snapshot", runState: response.runState });
          dispatch({
            type: "enqueued",
            id,
            sent: response.runState.items.some((item) => item.id === id),
            version: response.runState.version,
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
            !localRef.current.get(id)?.send ||
            localRef.current.get(id)?.withdrawal
          ) {
            logCommandFailure(log, failure, { threadId }, "moot");
            return;
          }
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
      const entry = localRef.current.get(controlId)?.send;
      if (!entry) return retrySwitch(controlId);
      if (entry.request !== "failed") return;
      dispatch({ type: "retry", id: controlId });
      const control = localRef.current.get(controlId)?.row.control;
      if (control) announce(controlStatusCopy(control, "queued"));
      const row = localRef.current.get(controlId)?.row;
      if (row?.control.kind === "compact") send(controlId, row.control);
    },
    [retrySwitch, send, dispatch],
  );

  const withdraw = useCallback(
    (queued: QueuedControl) => {
      if (queued.control.kind === "write_mode") {
        dispatch({ type: "hide_switch", id: queued.id });
        return withdrawSwitch(queued);
      }
      dispatch({ type: "withdraw", row: queued, requestId: crypto.randomUUID() });
      const occurrence = localRef.current.get(queued.id)?.withdrawal;
      announce(controlWithdrawnCopy(queued.control));
      const withdrawOnServer = async () => {
        try {
          const { outcome, runState } = await withdrawThreadControl(threadId, queued.id);
          dispatchRunState(threadId, { type: "snapshot", runState });
          dispatch({ type: "withdrawn", id: queued.id, version: runState.version });
          if (outcome === "already_started") announce(controlAlreadyStartedCopy(queued.control));
          revalidate();
        } catch (error) {
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
          if (!mounted.current || !localRef.current.get(queued.id)?.withdrawal) {
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

  const queued = useMemo(() => queuedControls(local), [local]);
  const droppedKey = [...local]
    .filter(([, entry]) => entry.droppedAt !== null)
    .map(([id, entry]) => `${id}:${entry.droppedAt}`)
    .join(",");
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
