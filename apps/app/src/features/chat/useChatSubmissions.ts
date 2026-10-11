/** React binding for journal rows and the single submission lifecycle. */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef } from "react";
import { createProjectThread } from "@/client/api/projects-api";
import {
  type ChatSubmission,
  getChatSubmissionAccountId,
  getChatSubmissionEpoch,
  readChatSubmissions,
  recordChatSubmission,
  retireChatSubmission,
  subscribeChatSubmissions,
} from "@/client/chat-submissions";
import { browserSubmissionLock } from "@/client/chat-submissions/adapters/browser-lock";
import { ChatSubmissionDriver } from "@/client/chat-submissions/driver";
import { composerSessionDraft } from "@/client/composer-drafts";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import { useOptionalThreadTransport } from "@/client/providers/TransportProvider";
import { removeChatRow } from "@/client/query/chat-projections";
import {
  invalidateProjectThreadData,
  invalidateWorkThreads,
} from "@/client/query/project-invalidation";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import type { ThreadStoreActions } from "@/client/stores";
import type { ComposerSubmitEnvelope } from "@/components/app/composer";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { makeOptimisticThread } from "@/lib/optimistic-thread";
import { whenDerived } from "./derivation/derive-conversation";
import type { UserTurnRecovery } from "./UserTurn";

// Row identity is tab-local. The stable record key survives Retry's remint.
const submissionRows = new Map<string, { threadId: string; turnId: string; fresh: boolean }>();
export function rememberSubmissionRow(
  accountId: string,
  recordId: string,
  threadId: string,
  turnId: string,
  fresh = false,
) {
  submissionRows.set(`${accountId}:${recordId}`, { threadId, turnId, fresh });
}
export function clearSubmissionRows() {
  submissionRows.clear();
}

export function useChatSubmissions(
  threadId: string,
  projectId: string,
  accountId: string,
  controller: ThreadRunController,
  actions: ThreadStoreActions,
  focusComposer: () => void,
  dissolveChat: () => void,
) {
  const queryClient = useQueryClient();
  const transport = useOptionalThreadTransport();
  const accountSignal = useOptionalAccountEpochSignal();
  const driver = useRef<ChatSubmissionDriver | null>(null);
  const failed = useRef(new Set<string>());
  const editing = useRef(new Set<string>());
  const [, render] = useReducer((value: number) => value + 1, 0);
  const latest = useRef({ actions, focusComposer, dissolveChat });
  latest.current = { actions, focusComposer, dissolveChat };

  useEffect(() => {
    const lifetime = new AbortController();
    const epoch = getChatSubmissionEpoch();
    const signal = accountSignal
      ? AbortSignal.any([accountSignal, lifetime.signal])
      : lifetime.signal;
    const current = () =>
      !signal.aborted &&
      getChatSubmissionAccountId() === accountId &&
      getChatSubmissionEpoch() === epoch;
    const session = {};
    controller.beginRecoverySession(session);
    failed.current.clear();
    const entries = () =>
      current()
        ? readChatSubmissions(accountId).filter((entry) => entry.threadId === threadId)
        : [];
    const row = (entry: ChatSubmission) => {
      const key = `${accountId}:${entry.recordId}`;
      const remembered = submissionRows.get(key);
      if (
        remembered &&
        latest.current.actions.turns(threadId)?.some((turn) => turn.id === remembered.turnId)
      )
        return remembered.turnId;
      const id = latest.current.actions.appendUserTurn(threadId, entry.blocks).id;
      rememberSubmissionRow(accountId, entry.recordId, threadId, id);
      return id;
    };
    let awaitingCreation = false;
    const synchronize = () => {
      if (!current()) return;
      const records = entries();
      if (records.length === 0 && awaitingCreation) {
        const unsent = composerSessionDraft(accountId, { kind: "chat", id: threadId });
        const snapshot = unsent.initialDraft;
        if (
          snapshot &&
          !composerSessionDraft(accountId, { kind: "new-chat", id: projectId }).editRejected(
            snapshot,
          )
        )
          return;
        unsent.handoff();
        awaitingCreation = false;
        removeChatRow(queryClient, projectId, threadId);
        latest.current.dissolveChat();
      } else if (records.length > 0) awaitingCreation = records.some((entry) => entry.creation);
      const ids = new Set(records.map((entry) => `${accountId}:${entry.recordId}`));
      let retired = false;
      for (const [key, remembered] of submissionRows) {
        if (!key.startsWith(`${accountId}:`) || remembered.threadId !== threadId || ids.has(key))
          continue;
        latest.current.actions.removeOptimisticUserTurn(threadId, remembered.turnId);
        submissionRows.delete(key);
        failed.current.delete(key.slice(accountId.length + 1));
        retired = true;
      }
      for (const entry of records) {
        if (entry.creation && entry.projectId)
          latest.current.actions.ensureThread(
            makeOptimisticThread({
              id: threadId,
              projectId: entry.projectId,
              title: entry.creation.title,
              timestamp: entry.createdAt,
              workId: entry.creation.workId,
              agent: {
                name: entry.creation.agentName,
                slug: entry.creation.agentSlug,
                selection: entry.creation.agentSelection,
              },
            }),
          );
        const id = row(entry);
        latest.current.actions.patchTurnStatus(
          threadId,
          id,
          entry.state || failed.current.has(entry.recordId) ? "error" : "pending",
        );
      }
      if (retired) latest.current.actions.invalidateThreadSnapshot(threadId);
      render();
    };
    const owner = new ChatSubmissionDriver({
      accountId,
      signal,
      isCurrent: current,
      session,
      lock: browserSubmissionLock,
      controller,
      journal: {
        entries,
        record: (entry) => current() && recordChatSubmission(accountId, entry),
        retire: (recordId) => current() && retireChatSubmission(accountId, recordId, epoch),
      },
      whenDerived,
      row,
      takeFresh: (recordId) => {
        const remembered = submissionRows.get(`${accountId}:${recordId}`);
        const fresh = remembered?.fresh ?? false;
        if (remembered) remembered.fresh = false;
        return fresh;
      },
      create: (entry, requestSignal) => {
        if (!entry.creation || !entry.projectId) throw new Error("Creation inputs missing");
        return createProjectThread(
          entry.projectId,
          {
            id: threadId,
            title: entry.creation.title,
            workId: entry.creation.workId,
            agentSelection: entry.creation.agentSelection,
          },
          { signal: requestSignal },
        );
      },
      created: (thread) => {
        if (!current()) return;
        latest.current.actions.ensureThread(thread);
        void invalidateProjectThreadData(queryClient, projectId);
        if (thread.workId) void invalidateWorkThreads(queryClient, projectId, thread.workId);
      },
      status: (entry, status) => {
        if (!current()) return;
        if (status === "error") failed.current.add(entry.recordId);
        else failed.current.delete(entry.recordId);
        latest.current.actions.patchTurnStatus(threadId, row(entry), status);
        render();
      },
      edited: (entry) => {
        // A different tab can record a complete new intent during the synchronous transfer.
        // Its record keeps that tab's destination alive; this writer's Edit still leaves here.
        if (entry.creation && current() && entries().length > 0) {
          removeChatRow(queryClient, projectId, threadId);
          latest.current.dissolveChat();
        }
      },
      transferForEdit: (entry) => {
        if (!current() || !entry.draft) return null;
        if (entry.creation) {
          const records = entries().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          if (records.some((record) => !record.draft)) return null;
          const unsent = composerSessionDraft(accountId, { kind: "chat", id: threadId });
          const snapshots = records.flatMap((record) => (record.draft ? [record.draft] : []));
          const later = unsent.initialDraft;
          if (later) snapshots.push(later);
          const transferred = {
            ...entry.draft,
            revision: Math.max(...snapshots.map((snapshot) => snapshot.revision)) + 1,
            doc: {
              type: "doc",
              content: snapshots.flatMap((snapshot) => snapshot.doc.content ?? []),
            },
            ownedUploads: snapshots.flatMap((snapshot) => snapshot.ownedUploads),
          };
          if (
            !composerSessionDraft(accountId, { kind: "new-chat", id: projectId }).editRejected(
              transferred,
            )
          )
            return null;
          unsent.handoff();
          return records.map((record) => record.recordId);
        }
        if (
          !composerSessionDraft(accountId, { kind: "chat", id: threadId }).editRejected(entry.draft)
        )
          return null;
        requestAnimationFrame(() => {
          if (current()) latest.current.focusComposer();
        });
        return [entry.recordId];
      },
    });
    driver.current = owner;
    synchronize();
    const wake = () => {
      if (current()) void owner.drive(threadId);
    };
    wake();
    const unsubscribe = subscribeChatSubmissions(synchronize);
    const storage = () => {
      synchronize();
      wake();
    };
    window.addEventListener("storage", storage);
    window.addEventListener("online", wake);
    const unsubscribeQuery = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "success" &&
        JSON.stringify(event.query.queryKey) === JSON.stringify(threadQueryKeys.snapshot(threadId))
      )
        wake();
    });
    const unsubscribeConnection = transport?.onConnectionState((state) => {
      if (state.kind === "connected") wake();
    });
    return () => {
      lifetime.abort();
      controller.endRecoverySession(session);
      if (driver.current === owner) driver.current = null;
      unsubscribe();
      unsubscribeQuery();
      unsubscribeConnection?.();
      window.removeEventListener("storage", storage);
      window.removeEventListener("online", wake);
    };
  }, [threadId, projectId, accountId, controller, accountSignal, queryClient, transport]);

  return {
    async submit(envelope: ComposerSubmitEnvelope): Promise<boolean> {
      if (!driver.current || getChatSubmissionAccountId() !== accountId) return false;
      const creation = readChatSubmissions(accountId).find(
        (entry) => entry.threadId === threadId && entry.creation,
      )?.creation;
      const entry: ChatSubmission = {
        recordId: envelope.submissionId,
        submissionId: envelope.submissionId,
        threadId,
        projectId,
        createdAt: new Date().toISOString(),
        text: envelope.text,
        blocks: [...envelope.blocks],
        references: [...envelope.references],
        activatedSkillSlugs: [...envelope.activatedSkillSlugs],
        draft: envelope.draft,
        creation,
      };
      // Remember before notifying subscribers so every pane reuses this optimistic row.
      if (!recordChatSubmission(accountId, entry)) return false;
      const remembered = submissionRows.get(`${accountId}:${entry.recordId}`);
      if (remembered) remembered.fresh = true;
      else
        rememberSubmissionRow(
          accountId,
          entry.recordId,
          threadId,
          actions.appendUserTurn(threadId, entry.blocks).id,
          true,
        );
      composerSessionDraft(accountId, { kind: "chat", id: threadId }).handoffSubmitted(
        envelope.draft,
      );
      void driver.current.drive(threadId);
      return true;
    },
    rowActions(turnId: string): UserTurnRecovery | null {
      const entry = readChatSubmissions(accountId).find(
        (record) =>
          record.threadId === threadId &&
          submissionRows.get(`${accountId}:${record.recordId}`)?.turnId === turnId,
      );
      if (!entry || !(entry.state || failed.current.has(entry.recordId))) return null;
      return {
        onRetry: () => {
          void driver.current?.retry(entry.submissionId);
        },
        ...(entry.state === "rejected" && entry.draft
          ? {
              onEdit: () => {
                if (editing.current.has(entry.recordId)) return;
                editing.current.add(entry.recordId);
                render();
                void driver.current?.edit(entry.submissionId).finally(() => {
                  editing.current.delete(entry.recordId);
                  render();
                });
              },
              busy: editing.current.has(entry.recordId),
            }
          : {}),
      };
    },
  };
}
