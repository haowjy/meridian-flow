/**
 * useSwitchView — the chat's write-mode switch display, as a pure view over server facts.
 *
 * Every server fact about a switch is a whole `RunState`, and the chat's mounted subscriber
 * (`useThreadSnapshotSync`) takes them into the chat's run-state slice: the accepted snapshot's,
 * each `meridian.run_state` frame, the `switched` frame. This hook reads that slice and folds
 * it for the toolbar's mode and the queued rows. It carries the journal's switches and the
 * writer's Withdraw into the slice, speaks queued and applied transitions (the one announcer
 * for a switch; a failure stays with the journal owner's keyed announcement), and marks the
 * Works and project thread lists stale when a switch applies.
 *
 * The bridge row, an applied switch whose divider has not rendered yet, is derived here from the
 * slice's applied facts and the dividers the transcript shows: it leaves with its divider. What
 * has been spoken is the slice's too, so a remount repeats no announcement.
 *
 * One host per chat per tab: the desktop shell keeps one `ChatSurface` and moves it between
 * the center and the dock, so a chat has one mounted `ChatView` and so one view. Two would
 * each announce. A dev-only registry warns when a second mounts for a chat that has one.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { readWriteModeSwitch } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { withdrawThreadControl } from "@/client/api/threads-api";
import type { JournalSwitch } from "@/client/chat-submissions/owner";
import { invalidateProjectThreadData } from "@/client/query/project-invalidation";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { switchDisplay } from "@/client/run-state/run-state-slice";
import { announce, announceError, useRunStateSlice, useThreadActions } from "@/client/stores";
import {
  controlAlreadyStartedCopy,
  controlStatusCopy,
  controlWithdrawnCopy,
  writeModeSwitchedCopy,
} from "./control-copy";
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
  journal: SwitchJournal;
}): SwitchView {
  const { threadId, projectId, turns, journal } = input;
  const queryClient = useQueryClient();
  const actions = useThreadActions();
  const { dispatchRunState: dispatch } = actions;
  const { view, news, applied, spoken } = useRunStateSlice(threadId);
  useSingleHostWarning(threadId);
  const latest = useRef({ journal, projectId });
  latest.current = { journal, projectId };

  useLayoutEffect(
    () => dispatch(threadId, { type: "journal", switches: journal.pending }),
    [dispatch, threadId, journal.pending],
  );

  // The slice decides what is news and how much of it was told (`spoken`, which outlives this
  // mount); this speaks the rest and records that it did.
  useEffect(() => {
    const queued = news.filter((entry) => entry.n > spoken.queued);
    const appliedNow = applied.filter((entry) => entry.n > spoken.applied);
    if (queued.length === 0 && appliedNow.length === 0) return;
    for (const entry of queued) announce(controlStatusCopy(entry.control, "queued"));
    for (const entry of appliedNow) {
      announce(writeModeSwitchedCopy(entry.mode));
      void invalidateProjectThreadData(queryClient, latest.current.projectId);
    }
    dispatch(threadId, {
      type: "spoken",
      queued: news.at(-1)?.n ?? 0,
      applied: applied.at(-1)?.n ?? 0,
    });
  }, [news, applied, spoken, dispatch, queryClient, threadId]);

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
      dispatch(threadId, { type: "withdraw", id });
      const onServer = async () => {
        try {
          const answer = await withdrawThreadControl(threadId, id);
          const { outcome } = answer;
          dispatch(threadId, { type: "withdrawn", id, runState: answer.runState });
          if (outcome === "withdrawn") announce(controlWithdrawnCopy(row.control));
          // The divider shows a started one.
          if (outcome === "already_started") announce(controlAlreadyStartedCopy(row.control));
          revalidate();
        } catch (error) {
          // The server never had it: nothing to withdraw.
          if (httpErrorStatus(error) === 404)
            return dispatch(threadId, { type: "dropWithdraw", id });
          dispatch(threadId, { type: "withdraw", id, failed: true });
          announceError(t`Couldn't withdraw. Try again.`);
        }
      };
      // A switch the journal holds that the server can't have (never posted, or refused):
      // taking it out of the journal is the withdrawal, and releases what waited behind it.
      // One the server may hold stays, and offers Retry only.
      void latest.current.journal.withdraw(id).then((result) => {
        if (result === "admitted") return onServer();
        dispatch(threadId, { type: "dropWithdraw", id });
        if (result === "removed") announce(controlWithdrawnCopy(row.control));
      });
    },
    [dispatch, revalidate, threadId],
  );

  const dividerIds = useMemo(
    () => new Set(turns.flatMap((turn) => (readWriteModeSwitch(turn) ? [turn.id] : []))),
    [turns],
  );
  const folded = useMemo(() => switchDisplay(view, input.writeMode), [view, input.writeMode]);
  const rows = useMemo<QueuedControl[]>(() => {
    const own = folded.rows.map((row) => ({
      id: row.id,
      control: { kind: "write_mode" as const, mode: row.mode },
      status: row.status,
      ...(row.awaitingServer ? { awaitingServer: true } : {}),
    }));
    // The bridge: an applied switch whose divider has not rendered yet.
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
