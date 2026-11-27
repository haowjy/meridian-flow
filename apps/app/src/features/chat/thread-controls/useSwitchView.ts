import type { AiWriteMode } from "@meridian/contracts/works";
import { type JournalSwitch, queuedSwitchKey, switchDisplay } from "@meridian/thread-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { announce } from "@/client/announcements";
import { httpErrorStatus } from "@/client/api/http-client";
import { withdrawThreadControl } from "@/client/api/threads-api";
import {
  invalidateProjectThreadData,
  invalidateWriteModeReads,
} from "@/client/query/project-invalidation";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { useRunStateSlice, useThreadActions } from "@/client/stores";
import { controlAlreadyStartedCopy, controlStatusCopy, controlWithdrawnCopy } from "./control-copy";
import type { QueuedControl } from "./thread-controls";

export type SwitchJournal = {
  pending: readonly JournalSwitch[];
  submit(id: string, mode: AiWriteMode): boolean;
  retry(id: string): void;
  withdraw(id: string): Promise<"removed" | "admitted" | "kept">;
};

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
  writeMode: AiWriteMode;
  switchWriteMode(mode: AiWriteMode): void;
  retry(id: string): void;
  withdraw(row: QueuedControl): void;
};

export function useSwitchView(input: {
  threadId: string;
  projectId: string;
  writeMode: AiWriteMode;
  journal: SwitchJournal;
  replyRunning: boolean;
}): SwitchView {
  const { threadId, projectId, journal, replyRunning } = input;
  const queryClient = useQueryClient();
  const actions = useThreadActions();
  const { dispatchRunState: dispatch } = actions;
  const { view, news, applied, spoken } = useRunStateSlice(threadId);
  useSingleHostWarning(threadId);
  const latest = useRef({ journal, projectId });
  useLayoutEffect(() => {
    latest.current = { journal, projectId };
  }, [journal, projectId]);

  useLayoutEffect(
    () => dispatch(threadId, { type: "journal", switches: journal.pending }),
    [dispatch, threadId, journal.pending],
  );

  useEffect(() => {
    const queued = news.filter((entry) => entry.n > spoken.queued);
    const appliedNow = applied.filter((entry) => entry.n > spoken.applied);
    if (queued.length === 0 && appliedNow.length === 0) return;
    for (const entry of queued) announce(controlStatusCopy(entry.control, "queued", entry.waiting));
    if (appliedNow.length > 0)
      void invalidateProjectThreadData(queryClient, latest.current.projectId);
    dispatch(threadId, {
      type: "spoken",
      queued: news.at(-1)?.n ?? 0,
      applied: applied.at(-1)?.n ?? 0,
    });
  }, [news, applied, spoken, dispatch, queryClient, threadId]);

  const queuedKey = useRef<string | null>(null);
  const record = view.record;
  useEffect(() => {
    if (!record) return;
    const key = queuedSwitchKey(record);
    const before = queuedKey.current;
    queuedKey.current = key;
    if (before !== null && before !== key)
      void invalidateWriteModeReads(queryClient, latest.current.projectId);
  }, [record, queryClient]);

  const revalidate = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) }),
    [queryClient, threadId],
  );

  const switchWriteMode = useCallback((mode: AiWriteMode) => {
    latest.current.journal.submit(crypto.randomUUID(), mode);
  }, []);

  const retry = useCallback((id: string) => latest.current.journal.retry(id), []);

  const withdraw = useCallback(
    (row: QueuedControl) => {
      const { id } = row;
      const requestId = crypto.randomUUID();
      dispatch(threadId, { type: "withdraw", id, requestId });
      const onServer = async () => {
        try {
          const answer = await withdrawThreadControl(threadId, id);
          const { outcome } = answer;
          dispatch(threadId, { type: "withdrawn", id, runState: answer.runState });
          if (outcome === "withdrawn") announce(controlWithdrawnCopy(row.control));
          if (outcome === "already_started") announce(controlAlreadyStartedCopy(row.control));
          void invalidateWriteModeReads(queryClient, latest.current.projectId);
          revalidate();
        } catch (error) {
          if (httpErrorStatus(error) === 404)
            return dispatch(threadId, { type: "dropWithdraw", id });
          dispatch(threadId, { type: "withdraw", id, requestId, failed: true });
        }
      };
      void latest.current.journal.withdraw(id).then((result) => {
        if (result === "admitted") return onServer();
        dispatch(threadId, { type: "dropWithdraw", id });
        if (result === "removed") announce(controlWithdrawnCopy(row.control));
      });
    },
    [dispatch, revalidate, threadId],
  );

  const folded = useMemo(() => switchDisplay(view, input.writeMode), [view, input.writeMode]);
  const rows = useMemo<QueuedControl[]>(
    () =>
      folded.rows.map((row) => ({
        id: row.id,
        control: { kind: "write_mode" as const, mode: row.mode },
        ...(row.status === "failed" || row.status === "withdraw_failed"
          ? { status: row.status, failure: row.failure }
          : { status: row.status }),
        ...(row.awaitingServer ? { awaitingServer: true } : {}),
        waiting: row.status === "sending" ? replyRunning : !row.awaitsRun,
        ...(row.awaitsRun ? { awaitsRun: true } : {}),
      })),
    [folded.rows, replyRunning],
  );

  return { rows, writeMode: folded.mode, switchWriteMode, retry, withdraw };
}
