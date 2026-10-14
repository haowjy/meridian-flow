/**
 * useSwitchLedger — the imperative shell around `switch-ledger.ts`.
 *
 * It feeds the chat's one ledger from each source (the journal, the server's
 * answer, the pending inbox, the fetched snapshot, the rendered transcript)
 * and carries the writer's Withdraw to the journal and the server. Sources are
 * read in layout effects so the ledger is current before the browser paints.
 * What it returns, the rows, the overlaid mode, is derived from the ledger
 * alone. It speaks queued and applied transitions (the one announcer for a
 * switch; a failure stays with the journal owner's keyed announcement), marks
 * the Works and project thread lists stale when a switch applies, and asks for
 * a snapshot while the ledger waits for proof. It reads only the snapshot the chat's history
 * host accepted (passed in); the query cache is read, observer-free, only for fetch state.
 *
 * One ledger host per chat per tab: the desktop shell keeps one `ChatSurface` and moves it
 * between the center and the dock, so a chat has one mounted `ChatView` and so one ledger.
 * Two would each announce, each hold their own witness, and each ask for proof. A dev-only
 * registry warns when a second mounts for a chat that already has one.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import type { ThreadPendingInbox } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { withdrawThreadControl } from "@/client/api/threads-api";
import type { JournalSwitch, SwitchAnswer } from "@/client/chat-submissions/owner";
import { invalidateProjectThreadData } from "@/client/query/project-invalidation";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import {
  type DeserializedThreadSnapshot,
  snapshotRequestCount,
  useThreadSnapshotCache,
} from "@/client/query/thread-snapshot-query";
import { announce, announceError } from "@/client/stores";
import {
  controlAlreadyStartedCopy,
  controlStatusCopy,
  controlWithdrawnCopy,
  writeModeSwitchedCopy,
} from "./control-copy";
import {
  EMPTY_LEDGER,
  ledgerReducer,
  overlaidMode,
  proofNeed,
  switchRows,
  transitions,
} from "./switch-ledger";
import type { QueuedControl } from "./thread-controls";
import { useProofLoop } from "./useProofLoop";
import { readWriteModeSwitch } from "./write-mode-model";

/** What the chat's submission journal offers the ledger: its switches and their order. */
export type SwitchJournal = {
  pending: readonly JournalSwitch[];
  submit(id: string, mode: AiWriteMode): boolean;
  retry(id: string): void;
  /**
   * `removed`: the server can't have it (never posted, or refused). `admitted`: the record
   * is gone, so the server's Withdraw is the way. `kept`: it may have it and hasn't said.
   */
  withdraw(id: string): Promise<"removed" | "admitted" | "kept">;
  onAnswered(listener: (answer: SwitchAnswer) => void): () => void;
};

const dividersOf = (turns: readonly Turn[]) =>
  turns.flatMap((turn) => {
    const facts = readWriteModeSwitch(turn);
    return facts ? [{ turnId: turn.id, controlId: facts.controlId, mode: facts.mode }] : [];
  });

/** Dev-only: the chats whose ledger is mounted in this tab, to catch a second host. */
const mountedLedgers = new Map<string, number>();

function useSingleHostWarning(threadId: string) {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hosts = (mountedLedgers.get(threadId) ?? 0) + 1;
    mountedLedgers.set(threadId, hosts);
    if (hosts > 1)
      console.warn(
        `Two switch ledgers are mounted for chat ${threadId}: a chat has one ledger host per tab.`,
      );
    return () => {
      const left = (mountedLedgers.get(threadId) ?? 1) - 1;
      if (left > 0) mountedLedgers.set(threadId, left);
      else mountedLedgers.delete(threadId);
    };
  }, [threadId]);
}

export type SwitchLedgerView = {
  rows: readonly QueuedControl[];
  /** The chat's mode as the writer should see it. */
  writeMode: AiWriteMode;
  /** Switch the chat's write mode; the row shows at once and the journal posts it in order. */
  switchWriteMode(mode: AiWriteMode): void;
  retry(id: string): void;
  withdraw(row: QueuedControl): void;
};

export function useSwitchLedger(input: {
  threadId: string;
  projectId: string;
  /** The chat's mode as the rendered snapshot says it. */
  writeMode: AiWriteMode;
  pending: ThreadPendingInbox;
  turns: readonly Turn[];
  /**
   * The snapshot the history host accepted and applied, with its request stamp. The ledger
   * reads no other: a response the host rejects never stands for the rendered base.
   */
  snapshot: DeserializedThreadSnapshot | null;
  /** The first successful history load is in the transcript: what is there now is not news. */
  historyLoaded: boolean;
  journal: SwitchJournal;
}): SwitchLedgerView {
  const { threadId, projectId, pending, turns, snapshot, historyLoaded, journal } = input;
  const queryClient = useQueryClient();
  useSingleHostWarning(threadId);
  const [ledger, dispatch] = useReducer(ledgerReducer, EMPTY_LEDGER);
  const latest = useRef({ journal, projectId });
  latest.current = { journal, projectId };
  const cache = useThreadSnapshotCache(threadId);

  useLayoutEffect(() => {
    dispatch({
      type: "journal",
      at: snapshotRequestCount(),
      records: journal.pending.map((entry) => ({
        id: entry.id,
        mode: entry.mode,
        seq: entry.seq,
        posted: entry.posted,
        refused: entry.refused,
        failed: entry.failed,
      })),
    });
  }, [journal.pending]);

  useLayoutEffect(() => {
    dispatch({
      type: "inbox",
      at: snapshotRequestCount(),
      items: pending.items.flatMap((item) =>
        item.intent === "control" && item.control?.kind === "write_mode"
          ? [{ id: item.id, mode: item.control.mode, serverSeq: item.seq }]
          : [],
      ),
    });
  }, [pending]);

  useLayoutEffect(() => {
    if (!snapshot) return;
    dispatch({
      type: "snapshot",
      request: snapshot.requestSeq ?? 0,
      pending: snapshot.liveState.pending.items.flatMap((item) =>
        item.intent === "control" && item.control?.kind === "write_mode"
          ? [{ id: item.id, mode: item.control.mode, serverSeq: item.seq }]
          : [],
      ),
      dividers: dividersOf(snapshot.turns),
    });
  }, [snapshot]);

  const dividers = useMemo(() => dividersOf(turns), [turns]);
  useLayoutEffect(() => dispatch({ type: "transcript", dividers }), [dividers]);
  useLayoutEffect(() => {
    if (historyLoaded) dispatch({ type: "settled" });
  }, [historyLoaded]);

  // The driver may be any pane's: the answer reaches whichever pane shows this chat.
  const { onAnswered } = journal;
  useEffect(
    () =>
      onAnswered(({ id, mode, response }) =>
        dispatch({
          type: "answer",
          id,
          mode,
          at: snapshotRequestCount(),
          result: response.turnId ? "applied" : response.pending ? "queued" : "cancelled",
        }),
      ),
    [onAnswered],
  );

  const revalidate = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) }),
    [queryClient, threadId],
  );

  const previous = useRef(ledger);
  useEffect(() => {
    const change = transitions(previous.current, ledger);
    previous.current = ledger;
    for (const mode of change.queued)
      announce(controlStatusCopy({ kind: "write_mode", mode }, "queued"));
    for (const mode of change.switched) announce(writeModeSwitchedCopy(mode));
    // The ledger overlay covers the gap until these refetch.
    if (change.applied) void invalidateProjectThreadData(queryClient, latest.current.projectId);
  }, [ledger, queryClient]);

  useProofLoop({
    need: proofNeed(ledger),
    snapshot: {
      requestSeq: snapshot?.requestSeq,
      dataUpdatedAt: cache?.dataUpdatedAt ?? 0,
      errorUpdatedAt: cache?.errorUpdatedAt ?? 0,
      isFetching: cache?.fetchStatus === "fetching",
    },
    acquire: revalidate,
  });

  const switchWriteMode = useCallback((mode: AiWriteMode) => {
    if (!latest.current.journal.submit(crypto.randomUUID(), mode)) {
      announceError(controlStatusCopy({ kind: "write_mode", mode }, "failed"));
    }
  }, []);

  const retry = useCallback((id: string) => latest.current.journal.retry(id), []);

  const withdraw = useCallback(
    (row: QueuedControl) => {
      const { id } = row;
      dispatch({ type: "withdraw_started", id });
      const done = (outcome: "withdrawn" | "already_started" | "not_found") =>
        dispatch({ type: "withdraw_done", id, outcome });
      const onServer = async () => {
        try {
          const { outcome } = await withdrawThreadControl(threadId, id);
          done(outcome);
          if (outcome === "withdrawn") announce(controlWithdrawnCopy(row.control));
          // The divider shows a started one.
          if (outcome === "already_started") announce(controlAlreadyStartedCopy(row.control));
          revalidate();
        } catch (error) {
          // The server never had it: nothing to withdraw, and nothing to wait for.
          if (httpErrorStatus(error) === 404) return done("not_found");
          dispatch({ type: "withdraw_failed", id });
          announceError(t`Couldn't withdraw. Try again.`);
        }
      };
      // A switch the journal holds that the server can't have (never posted, or refused):
      // taking it out of the journal is the withdrawal, and releases what waited behind it.
      // One the server may hold stays, and offers Retry only.
      void latest.current.journal.withdraw(id).then((result) => {
        if (result === "admitted") return onServer();
        dispatch({ type: "withdraw_done", id, outcome: result });
        if (result === "removed") announce(controlWithdrawnCopy(row.control));
      });
    },
    [revalidate, threadId],
  );

  const rows = useMemo(() => switchRows(ledger), [ledger]);
  const writeMode = useMemo(() => overlaidMode(input.writeMode, ledger), [input.writeMode, ledger]);
  return { rows, writeMode, switchWriteMode, retry, withdraw };
}
