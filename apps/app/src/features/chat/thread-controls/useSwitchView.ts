/**
 * useSwitchView — the chat's write-mode switch display, as a pure view over server facts.
 *
 * Every server fact about a switch carries one clock, the thread's event `seq`: the
 * accepted snapshot (labelled at its head), `inbox.changed` and `write_mode.switched`
 * frames, and the answer to a switch or its journal stamp. This hook only receives them
 * into the run-state view (`switch-record.ts` composes the record each one makes) and
 * folds the view for the toolbar's mode and the queued rows. It carries the writer's
 * Withdraw to the journal and the server, speaks queued and applied transitions (the one
 * announcer for a switch; a failure stays with the journal owner's keyed announcement),
 * and marks the Works and project thread lists stale when a switch applies.
 *
 * The bridge row, an applied switch whose divider has not rendered yet, is the transcript
 * layer's: it is keyed by the `write_mode.switched` frame's turn and leaves with its divider.
 *
 * One host per chat per tab: the desktop shell keeps one `ChatSurface` and moves it between
 * the center and the dock, so a chat has one mounted `ChatView` and so one view. Two would
 * each announce. A dev-only registry warns when a second mounts for a chat that has one.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import {
  compareSeq,
  EventType,
  parseSeq,
  WRITE_MODE_SWITCHED_EVENT,
} from "@meridian/contracts/protocol";
import { readWriteModeSwitch } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { withdrawThreadControl } from "@/client/api/threads-api";
import type { JournalSwitch } from "@/client/chat-submissions/owner";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { invalidateProjectThreadData } from "@/client/query/project-invalidation";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import type { DeserializedThreadSnapshot } from "@/client/query/thread-snapshot-query";
import { switchState } from "@/client/run-state/fold-switches";
import {
  addIntent,
  answerIntent,
  dropIntent,
  EMPTY_VIEW,
  type RunStateView,
  receiveRecord,
} from "@/client/run-state/run-state-view";
import { announce, announceError, useIsThreadPendingCreation } from "@/client/stores";
import { pendingInboxFromEvent } from "../pending-inbox";
import {
  controlAlreadyStartedCopy,
  controlStatusCopy,
  controlWithdrawnCopy,
  writeModeSwitchedCopy,
} from "./control-copy";
import {
  isWriteModeControl,
  recordFromAnswer,
  recordFromFrame,
  recordFromSnapshot,
  type SwitchFrame,
} from "./switch-record";
import type { QueuedControl } from "./thread-controls";

/** What the chat's submission journal offers the view: its switches, stamped once answered. */
export type SwitchJournal = {
  pending: readonly JournalSwitch[];
  submit(id: string, mode: AiWriteMode): boolean;
  retry(id: string): void;
  /**
   * `removed`: the server can't have it (never posted, or refused). `admitted`: the server
   * has it, so the server's Withdraw is the way. `kept`: it may have it and hasn't said.
   */
  withdraw(id: string): Promise<"removed" | "admitted" | "kept">;
};

type Action =
  | { type: "snapshot"; snapshot: DeserializedThreadSnapshot }
  | { type: "frame"; frame: SwitchFrame }
  | { type: "journal"; switches: readonly JournalSwitch[] }
  | { type: "withdraw"; id: string; failed?: boolean }
  | { type: "withdrawn"; id: string; seq: string }
  | { type: "dropWithdraw"; id: string };

function reduce(view: RunStateView, action: Action): RunStateView {
  switch (action.type) {
    case "snapshot":
      return receiveRecord(view, recordFromSnapshot(action.snapshot));
    case "frame": {
      const record = recordFromFrame(view.record, action.frame);
      return record ? receiveRecord(view, record) : view;
    }
    case "journal": {
      let next = view;
      const held = new Set(action.switches.map((entry) => entry.id));
      for (const entry of action.switches) {
        // A stamp is the server's answer, read as a fact by every tab.
        if (entry.answer) {
          next = receiveRecord(next, recordFromAnswer(next.record, entry.answer));
          next = answerIntent(
            addIntent(next, {
              kind: "switch",
              id: entry.id,
              order: entry.seq,
              mode: entry.mode,
              answer: null,
            }),
            "switch",
            entry.id,
            entry.answer.seq,
          );
        } else {
          next = addIntent(next, {
            kind: "switch",
            id: entry.id,
            order: entry.seq,
            mode: entry.mode,
            answer: null,
            failed: entry.failed,
            awaitingServer: entry.posted && !entry.refused,
          });
        }
      }
      // A record that vanished unstamped was withdrawn or refused here, or its stamp was
      // pruned while this tab was blind: either way frames bring the server state.
      for (const intent of next.intents)
        if (intent.kind === "switch" && intent.answer === null && !held.has(intent.id))
          next = dropIntent(next, "switch", intent.id);
      return next;
    }
    case "withdraw":
      return addIntent(view, {
        kind: "withdraw",
        id: action.id,
        order: 0,
        answer: null,
        failed: action.failed,
      });
    case "withdrawn":
      return answerIntent(view, "withdraw", action.id, action.seq);
    case "dropWithdraw":
      return dropIntent(view, "withdraw", action.id);
  }
}

/** Dev-only: the chats whose view is mounted in this tab, to catch a second host. */
const mountedViews = new Map<string, number>();

function useSingleHostWarning(threadId: string) {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hosts = (mountedViews.get(threadId) ?? 0) + 1;
    mountedViews.set(threadId, hosts);
    if (hosts > 1)
      console.warn(
        `Two switch views are mounted for chat ${threadId}: a chat has one view host per tab.`,
      );
    return () => {
      const left = (mountedViews.get(threadId) ?? 1) - 1;
      if (left > 0) mountedViews.set(threadId, left);
      else mountedViews.delete(threadId);
    };
  }, [threadId]);
}

type Applied = { turnId: string; controlId: string; mode: AiWriteMode };

function switchedFrom(event: { type: string; name?: string; value?: unknown }): Applied | null {
  if (event.type !== EventType.CUSTOM || event.name !== WRITE_MODE_SWITCHED_EVENT) return null;
  const value = event.value as Partial<Record<string, unknown>> | undefined;
  if (
    !value ||
    typeof value.turnId !== "string" ||
    typeof value.controlId !== "string" ||
    (value.mode !== "draft" && value.mode !== "direct")
  )
    return null;
  return { turnId: value.turnId, controlId: value.controlId, mode: value.mode };
}

export type SwitchView = {
  rows: readonly QueuedControl[];
  /** The chat's mode as the writer should see it. */
  writeMode: AiWriteMode;
  /** Switch the chat's write mode; the row shows at once and the journal posts it in order. */
  switchWriteMode(mode: AiWriteMode): void;
  retry(id: string): void;
  withdraw(row: QueuedControl): void;
};

export function useSwitchView(input: {
  threadId: string;
  projectId: string;
  /** The mode to show before the server has sent a record. */
  writeMode: AiWriteMode;
  turns: readonly Turn[];
  /** The snapshot the chat's history host accepted and applied. */
  snapshot: DeserializedThreadSnapshot | null;
  journal: SwitchJournal;
}): SwitchView {
  const { threadId, projectId, turns, snapshot, journal } = input;
  const queryClient = useQueryClient();
  const transport = useThreadTransport();
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  useSingleHostWarning(threadId);
  const [view, dispatch] = useReducer(reduce, EMPTY_VIEW);
  const [applied, setApplied] = useState<readonly Applied[]>([]);
  const latest = useRef({ journal, projectId });
  latest.current = { journal, projectId };
  /** The first record's version: what it holds is not news, and neither is a frame at or below it. */
  const seed = useRef<string | null>(null);
  const heard = useRef(new Set<string>());
  const order = useRef(0);

  useLayoutEffect(() => {
    if (snapshot) dispatch({ type: "snapshot", snapshot });
  }, [snapshot]);

  useLayoutEffect(
    () => dispatch({ type: "journal", switches: journal.pending }),
    [journal.pending],
  );

  useEffect(() => {
    if (isPendingCreation) return;
    return transport.subscribe(threadId, {
      onEvent: ({ event, seq, sourceThreadId }) => {
        if (sourceThreadId && sourceThreadId !== threadId) return;
        if ("threadId" in event && event.threadId !== threadId) return;
        if (seq == null || parseSeq(seq) === null) return;
        const inbox = pendingInboxFromEvent(event);
        if (inbox)
          return dispatch({ type: "frame", frame: { kind: "inbox", seq, pending: inbox } });
        const switched = switchedFrom(event);
        if (!switched) return;
        dispatch({ type: "frame", frame: { kind: "switched", seq, mode: switched.mode } });
        if (seed.current === null || compareSeq(seq, seed.current) <= 0) return;
        setApplied((known) =>
          known.some((entry) => entry.turnId === switched.turnId) ? known : [...known, switched],
        );
        announce(writeModeSwitchedCopy(switched.mode));
        void invalidateProjectThreadData(queryClient, latest.current.projectId);
      },
    });
  }, [transport, threadId, isPendingCreation, queryClient]);

  // A queued switch the server newly lists is news; the first record's, and a replay, are not.
  useEffect(() => {
    const { record } = view;
    if (!record) return;
    const first = seed.current === null;
    if (first) seed.current = record.version;
    for (const item of record.items) {
      if (!isWriteModeControl(item) || item.control?.kind !== "write_mode") continue;
      if (heard.current.has(item.id)) continue;
      heard.current.add(item.id);
      if (!first) announce(controlStatusCopy(item.control, "queued"));
    }
  }, [view.record]);

  const revalidate = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) }),
    [queryClient, threadId],
  );

  const switchWriteMode = useCallback((mode: AiWriteMode) => {
    if (!latest.current.journal.submit(crypto.randomUUID(), mode))
      announceError(controlStatusCopy({ kind: "write_mode", mode }, "failed"));
  }, []);

  const retry = useCallback((id: string) => latest.current.journal.retry(id), []);

  const withdraw = useCallback(
    (row: QueuedControl) => {
      const { id } = row;
      // The row goes at once, whichever side owns it.
      dispatch({ type: "withdraw", id });
      const onServer = async () => {
        try {
          const { outcome, seq } = await withdrawThreadControl(threadId, id);
          dispatch({ type: "withdrawn", id, seq });
          if (outcome === "withdrawn") announce(controlWithdrawnCopy(row.control));
          // The divider shows a started one.
          if (outcome === "already_started") announce(controlAlreadyStartedCopy(row.control));
          revalidate();
        } catch (error) {
          // The server never had it: nothing to withdraw.
          if (httpErrorStatus(error) === 404) return dispatch({ type: "dropWithdraw", id });
          dispatch({ type: "withdraw", id, failed: true });
          announceError(t`Couldn't withdraw. Try again.`);
        }
      };
      // A switch the journal holds that the server can't have (never posted, or refused):
      // taking it out of the journal is the withdrawal, and releases what waited behind it.
      // One the server may hold stays, and offers Retry only.
      void latest.current.journal.withdraw(id).then((result) => {
        if (result === "admitted") return onServer();
        dispatch({ type: "dropWithdraw", id });
        if (result === "removed") announce(controlWithdrawnCopy(row.control));
      });
    },
    [revalidate, threadId],
  );

  const dividerIds = useMemo(
    () => new Set(turns.flatMap((turn) => (readWriteModeSwitch(turn) ? [turn.id] : []))),
    [turns],
  );
  const folded = useMemo(() => switchState(view, input.writeMode), [view, input.writeMode]);
  const rows = useMemo<QueuedControl[]>(() => {
    const own = folded.rows.map((row) => ({
      id: row.id,
      control: { kind: "write_mode" as const, mode: row.mode },
      status: row.status,
      ...(row.awaitingServer ? { awaitingServer: true } : {}),
    }));
    const bridge = applied
      .filter(
        (entry) => !dividerIds.has(entry.turnId) && !own.some((row) => row.id === entry.controlId),
      )
      .map((entry) => ({
        id: entry.controlId,
        control: { kind: "write_mode" as const, mode: entry.mode },
        status: "queued" as const,
      }));
    return [...own, ...bridge];
  }, [folded.rows, applied, dividerIds]);

  return { rows, writeMode: folded.mode, switchWriteMode, retry, withdraw };
}
