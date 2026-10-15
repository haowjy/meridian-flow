/**
 * useSwitchView — the chat's write-mode switch display, as a pure view over server facts.
 *
 * Every server fact about a switch carries one clock, the thread's event `seq`: the
 * accepted snapshot (labelled at its head), `inbox.changed` and `write_mode.switched`
 * frames, and the answer to a switch or its journal stamp. This hook only receives them
 * into the run-state view (`switch-record.ts` composes the record each one makes) and
 * folds the view for the toolbar's mode and the pending rows. It carries the writer's
 * Stop to the journal and the server, speaks a switch once when it becomes pending (the
 * one announcer for a switch, silent when it applies; a failure stays with the journal
 * owner's keyed announcement), and marks the Works and project thread lists stale when a
 * switch applies.
 *
 * The bridge row, an applied switch whose turn has not rendered yet, is the transcript
 * layer's: it is keyed by the `write_mode.switched` frame's turn and leaves with that turn.
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
import {
  invalidateProjectThreadData,
  invalidateWriteModeReads,
} from "@/client/query/project-invalidation";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import type { DeserializedThreadSnapshot } from "@/client/query/thread-snapshot-query";
import { announce, announceError, useIsThreadPendingCreation } from "@/client/stores";
import { pendingInboxFromEvent, queuedSwitchKey } from "../pending-inbox";
import { controlAlreadyStartedCopy, controlStatusCopy, controlStoppedCopy } from "./control-copy";
import { switchDisplay } from "./switch-record";
import { INITIAL_SWITCH_STATE, reduceSwitch } from "./switch-reducer";
import type { QueuedControl } from "./thread-controls";
import { readWriteModeSwitch } from "./write-mode-model";

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
  /** A reply or compaction holds the chat: a pending switch waits for it, and says so. */
  replyRunning: boolean;
}): SwitchView {
  const { threadId, projectId, turns, snapshot, journal, replyRunning } = input;
  const queryClient = useQueryClient();
  const transport = useThreadTransport();
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  useSingleHostWarning(threadId);
  const [{ view, news }, dispatch] = useReducer(reduceSwitch, INITIAL_SWITCH_STATE);
  const [applied, setApplied] = useState<readonly Applied[]>([]);
  const latest = useRef({ journal, projectId });
  latest.current = { journal, projectId };
  const queuedKey = useRef("");
  /** The first record's version: what it holds is not news, and neither is a frame at or below it. */
  const seed = useRef<string | null>(null);
  /** Applied switches already announced: a replayed frame is not news twice. */
  const switchedTurns = useRef(new Set<string>());
  const announcedQueued = useRef(0);

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
        if (inbox) {
          // Another tab's queue, cancel or withdrawal changes the Work default and list mode.
          const key = queuedSwitchKey(inbox);
          if (key !== queuedKey.current) {
            queuedKey.current = key;
            void invalidateWriteModeReads(queryClient, latest.current.projectId);
          }
          return dispatch({ type: "frame", frame: { kind: "inbox", seq, pending: inbox } });
        }
        const switched = switchedFrom(event);
        if (!switched) return;
        dispatch({
          type: "frame",
          frame: { kind: "switched", seq, mode: switched.mode, controlId: switched.controlId },
        });
        if (seed.current === null || compareSeq(seq, seed.current) <= 0) return;
        if (switchedTurns.current.has(switched.turnId)) return;
        switchedTurns.current.add(switched.turnId);
        setApplied((known) => [...known, switched]);
        void invalidateProjectThreadData(queryClient, latest.current.projectId);
      },
    });
  }, [transport, threadId, isPendingCreation, queryClient]);

  useEffect(() => {
    if (view.record && seed.current === null) seed.current = view.record.version;
  }, [view.record]);

  // The reducer decides what is news; this speaks each queued switch once.
  useEffect(() => {
    for (const entry of news) {
      if (entry.n <= announcedQueued.current) continue;
      announcedQueued.current = entry.n;
      announce(controlStatusCopy(entry.control, "queued", entry.waiting));
    }
  }, [news]);

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
          const answer = await withdrawThreadControl(threadId, id);
          const { outcome } = answer;
          dispatch({ type: "withdrawn", id, answer });
          if (outcome === "withdrawn") announce(controlStoppedCopy(row.control));
          // The switch turn shows a started one.
          if (outcome === "already_started") announce(controlAlreadyStartedCopy(row.control));
          // Stop restores the Work default.
          void invalidateWriteModeReads(queryClient, latest.current.projectId);
          revalidate();
        } catch (error) {
          // The server never had it: nothing to withdraw.
          if (httpErrorStatus(error) === 404) return dispatch({ type: "dropWithdraw", id });
          dispatch({ type: "withdraw", id, failed: true });
          announceError(t`Couldn't stop. Try again.`);
        }
      };
      // A switch the journal holds that the server can't have (never posted, or refused):
      // taking it out of the journal is the withdrawal, and releases what waited behind it.
      // One the server may hold stays, and offers Retry only.
      void latest.current.journal.withdraw(id).then((result) => {
        if (result === "admitted") return onServer();
        dispatch({ type: "dropWithdraw", id });
        if (result === "removed") announce(controlStoppedCopy(row.control));
      });
    },
    [queryClient, revalidate, threadId],
  );

  const dividerIds = useMemo(
    () => new Set(turns.flatMap((turn) => (readWriteModeSwitch(turn) ? [turn.id] : []))),
    [turns],
  );
  // Only a switch whose turn has not rendered yet needs the bridge.
  useEffect(() => {
    setApplied((known) =>
      known.some((entry) => dividerIds.has(entry.turnId))
        ? known.filter((entry) => !dividerIds.has(entry.turnId))
        : known,
    );
  }, [dividerIds, applied]);
  const folded = useMemo(() => switchDisplay(view, input.writeMode), [view, input.writeMode]);
  const rows = useMemo<QueuedControl[]>(() => {
    // The server says whether a run it already started leaves a switch behind. Before it
    // has listed the switch, a running reply is the only thing that could.
    const own = folded.rows.map((row) => {
      const item = view.record?.items.find((known) => known.id === row.id);
      return {
        id: row.id,
        control: { kind: "write_mode" as const, mode: row.mode },
        status: row.status,
        waiting: item ? item.deliveryState === "waiting" : replyRunning,
        ...(row.awaitingServer ? { awaitingServer: true } : {}),
      };
    });
    const bridge = applied
      .filter(
        (entry) => !dividerIds.has(entry.turnId) && !own.some((row) => row.id === entry.controlId),
      )
      .map((entry) => ({
        id: entry.controlId,
        control: { kind: "write_mode" as const, mode: entry.mode },
        status: "applied" as const,
      }));
    return [...own, ...bridge];
  }, [folded.rows, applied, dividerIds, view.record, replyRunning]);

  return { rows, writeMode: folded.mode, switchWriteMode, retry, withdraw };
}
