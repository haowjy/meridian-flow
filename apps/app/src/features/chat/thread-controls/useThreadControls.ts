/**
 * useThreadControls — the imperative shell around `thread-controls.ts`.
 *
 * Mints command ids, shows the queued row before the network answers,
 * enqueues and withdraws through the threads API, and asks the snapshot to
 * revalidate so the new state reaches the transcript. Withdraw removes the row
 * at once and, once any in-flight enqueue settles, always asks the server: an
 * enqueue that looked failed may still have landed. A 404 means the server
 * did not have it yet: the local send goes, and the row shows again if the
 * inbox lists it later. Also stops a running compaction
 * divider through the turn cancel route. Announces each state change the
 * writer caused.
 *
 * Two kinds ride here. `/compact` posts from this hook. A write-mode switch is
 * a record in the chat's submission journal, posted in order with the messages
 * around it by the journal's one driver; this hook shows its rows, takes the
 * driver's answer, and keeps the composer's mode honest while it is queued.
 */
import { t } from "@lingui/core/macro";
import type { ControlBody, ThreadPendingInbox } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { enqueueThreadControl, withdrawThreadControl } from "@/client/api/threads-api";
import type { JournalSwitch, SwitchAnswer } from "@/client/chat-submissions/owner";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { applyWriteModeAnswer } from "@/client/query/write-mode-cache";
import { announce, announceError } from "@/client/stores";
import { useTurnStop } from "../useTurnStop";
import { controlAlreadyStartedCopy, controlStatusCopy, controlWithdrawnCopy } from "./control-copy";
import {
  type CompactControl,
  controlsReducer,
  mergeQueuedControls,
  NO_LOCAL_CONTROLS,
  overlaidWriteMode,
  type QueuedControl,
  switchesCancelledBy,
} from "./thread-controls";
import { useSwitchAnnouncements } from "./useSwitchAnnouncements";

/** What the chat's submission journal offers the controls: its switches and their order. */
export type SwitchJournal = {
  pending: readonly JournalSwitch[];
  submit(id: string, mode: AiWriteMode): boolean;
  retry(id: string): void;
  /** `removed`: it never reached the server. `admitted`: it did, so the server's Withdraw is the way. */
  withdraw(id: string): Promise<"removed" | "admitted">;
  onAnswered(listener: (answer: SwitchAnswer) => void): () => void;
};

export type ThreadControls = {
  queued: readonly QueuedControl[];
  stoppingTurnIds: ReadonlySet<string>;
  /** The chat's mode as the writer should see it: queued and local switches laid over the server's. */
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
  projectId: string;
  /** The chat's mode as the server last said it. */
  writeMode: AiWriteMode;
  pending: ThreadPendingInbox;
  answeredControlIds: ReadonlySet<string>;
  switches: SwitchJournal;
}): ThreadControls {
  const { threadId, projectId, pending, answeredControlIds, switches } = input;
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

  const mergeInput = useMemo(
    () => ({
      local,
      pending,
      journaled: switches.pending,
      executedControlIds: answeredControlIds,
    }),
    [answeredControlIds, local, pending, switches.pending],
  );
  const mergeInputRef = useRef(mergeInput);
  mergeInputRef.current = mergeInput;
  const latest = useRef({ switches, projectId });
  latest.current = { switches, projectId };

  useEffect(() => {
    dispatch({ type: "listed", pendingIds: new Set(pending.items.map((item) => item.id)) });
  }, [pending]);

  // The driver may be any pane's: the answer reaches whichever pane shows this chat.
  const { onAnswered } = switches;
  useEffect(
    () =>
      onAnswered(({ id, mode, response }) => {
        const cancelled = response.pending === null && response.turnId === null;
        dispatch({
          type: "switch_answered",
          id,
          control: { kind: "write_mode", mode },
          pending: response.pending,
          turnId: response.turnId,
          cancels: cancelled ? switchesCancelledBy(mergeInputRef.current, { id, mode }) : [],
        });
        // The switch applied: the mode is the server's now, before the divider arrives.
        if (response.turnId) {
          applyWriteModeAnswer(queryClient, {
            projectId: latest.current.projectId,
            threadId,
            mode,
            turnId: response.turnId,
          });
        }
        revalidate();
      }),
    [onAnswered, queryClient, revalidate, threadId],
  );

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

  const switchWriteMode = useCallback((mode: AiWriteMode) => {
    const control = { kind: "write_mode", mode } as const;
    if (!latest.current.switches.submit(crypto.randomUUID(), mode)) {
      announceError(controlStatusCopy(control, "failed"));
    }
  }, []);

  const retry = useCallback(
    (controlId: string) => {
      const journaled = latest.current.switches.pending.find((entry) => entry.id === controlId);
      if (journaled) {
        latest.current.switches.retry(controlId);
        return;
      }
      const entry = localRef.current.sends.find((candidate) => candidate.id === controlId);
      if (entry?.request !== "failed") return;
      dispatch({ type: "retry", id: controlId });
      announce(controlStatusCopy(entry.control, "queued"));
      // Same id: the server treats a repeat as the original request.
      send(controlId, entry.control);
    },
    [send],
  );

  const withdraw = useCallback(
    (queued: QueuedControl) => {
      dispatch({ type: "withdraw", id: queued.id });
      announce(controlWithdrawnCopy(queued.control));
      const settle = () => dispatch({ type: "withdrawn", id: queued.id });
      const withdrawOnServer = async () => {
        try {
          const { outcome } = await withdrawThreadControl(threadId, queued.id);
          settle();
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
          announceError(t`Couldn't withdraw. Try again.`);
        }
      };
      // A switch the journal still holds never reached the server: taking it out
      // of the journal is the withdrawal, and releases what waited behind it.
      if (latest.current.switches.pending.some((entry) => entry.id === queued.id)) {
        void latest.current.switches.withdraw(queued.id).then((result) => {
          if (result === "removed") settle();
          else return withdrawOnServer();
        });
        return;
      }
      void (inflight.current.get(queued.id) ?? Promise.resolve()).then(withdrawOnServer);
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

  const queued = useMemo(() => mergeQueuedControls(mergeInput), [mergeInput]);
  useSwitchAnnouncements(queued);
  const writeMode = useMemo(
    () => overlaidWriteMode(input.writeMode, queued),
    [input.writeMode, queued],
  );

  return {
    queued,
    stoppingTurnIds: turnStop.stopping,
    writeMode,
    enqueue,
    switchWriteMode,
    retry,
    withdraw,
    stop,
  };
}
