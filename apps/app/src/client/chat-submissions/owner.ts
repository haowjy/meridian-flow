/** Tab submission model: durable handoff, row projection, and writer commands. */
import type { QueryClient } from "@tanstack/react-query";
import { HttpResponseError } from "@/client/api/http-client";
import { createProjectThread } from "@/client/api/projects-api";
import { deserializeThreadSnapshot, getThreadSnapshot } from "@/client/api/threads-api";
import { composerSessionDraft } from "@/client/composer-drafts";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import { removeChatRow } from "@/client/query/chat-projections";
import {
  invalidateProjectThreadData,
  invalidateWorkThreads,
} from "@/client/query/project-invalidation";
import type { ThreadStoreActions } from "@/client/stores";
import type { ComposerSubmitEnvelope } from "@/components/app/composer";
import { whenDerived } from "@/features/chat/derivation/derive-conversation";
import type { UserTurnRecovery } from "@/features/chat/UserTurn";
import { makeOptimisticThread } from "@/lib/optimistic-thread";
import { browserSubmissionLock } from "./adapters/browser-lock";
import { ChatSubmissionDriver } from "./driver";
import {
  getChatSubmissionEpoch,
  readChatSubmissionSnapshot,
  readChatSubmissions,
  recordChatSubmission,
  retireChatSubmission,
} from "./index";
import { abortable } from "./lock";
import type { ChatSubmission } from "./store";

type Row = {
  threadId: string;
  turnId: string;
  fresh: boolean;
  failed?: boolean;
  localFailure?: boolean;
  busy?: boolean;
  status?: "pending" | "error";
};
const rows = new Map<string, Row>();
const key = (accountId: string, recordId: string) => `${accountId}:${recordId}`;

function projectRow(accountId: string, entry: ChatSubmission, actions: ThreadStoreActions): Row {
  const id = key(accountId, entry.recordId);
  let row = rows.get(id);
  if (!row || !actions.turns(entry.threadId)?.some((turn) => turn.id === row?.turnId)) {
    row = {
      threadId: entry.threadId,
      turnId: actions.appendUserTurn(entry.threadId, entry.blocks).id,
      fresh: row?.fresh ?? false,
    };
    rows.set(id, row);
  }
  return row;
}

/** The durable write is the commit point. Projection faults cannot return the words to Send. */
export function recordAndProjectSubmission(
  accountId: string,
  entry: ChatSubmission,
  actions: ThreadStoreActions,
): boolean {
  if (!recordChatSubmission(accountId, entry)) return false;
  try {
    if (entry.creation && entry.projectId)
      actions.ensureThread(
        makeOptimisticThread({
          id: entry.threadId,
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
    projectRow(accountId, entry, actions).fresh = true;
    if (entry.draft)
      composerSessionDraft(accountId, {
        kind: entry.creation ? "new-chat" : "chat",
        id: entry.creation ? (entry.projectId ?? entry.threadId) : entry.threadId,
      }).handoffSubmitted(entry.draft);
  } catch (error) {
    reportError(error);
  }
  return true;
}

type OwnerOptions = {
  accountId: string;
  threadId: string;
  projectId: string;
  signal: AbortSignal;
  current(): boolean;
  controller: ThreadRunController;
  actions: ThreadStoreActions;
  queryClient: QueryClient;
  changed(): void;
  failed(recordId: string): void;
  clear(recordId: string): void;
  focusComposer(): void;
  dissolveChat(): void;
};

export class ChatSubmissionOwner {
  readonly driver: ChatSubmissionDriver;
  presentation = new Map<string, UserTurnRecovery>();
  private readonly session = {};
  private destination: "unknown" | "creating" | "created" | "editing" = "unknown";
  private reconciling = false;
  private readonly epoch = getChatSubmissionEpoch();
  constructor(private readonly options: OwnerOptions) {
    const { accountId, threadId, projectId, signal, current, controller, actions, queryClient } =
      options;
    controller.beginRecoverySession(this.session);
    this.driver = new ChatSubmissionDriver({
      accountId,
      signal,
      isCurrent: current,
      session: this.session,
      controller,
      lock: browserSubmissionLock,
      journal: {
        entries: () => this.entries(),
        record: (entry) => current() && recordChatSubmission(accountId, entry),
        retire: (id) => current() && retireChatSubmission(accountId, id, this.epoch),
      },
      whenDerived,
      row: (entry) => projectRow(accountId, entry, actions).turnId,
      takeFresh: (id) => {
        const row = rows.get(key(accountId, id));
        const fresh = row?.fresh ?? false;
        if (row) row.fresh = false;
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
        this.destination = "created";
        actions.ensureThread(thread);
        void invalidateProjectThreadData(queryClient, projectId);
        if (thread.workId) void invalidateWorkThreads(queryClient, projectId, thread.workId);
      },
      status: (entry, status, localFailure) => {
        const row = projectRow(accountId, entry, actions);
        row.status = status;
        if (status === "error") {
          if (!row.failed) options.failed(entry.recordId);
          row.failed = true;
          row.localFailure = localFailure ?? false;
        } else {
          options.clear(entry.recordId);
          row.failed = false;
        }
        actions.patchTurnStatus(threadId, row.turnId, status);
        this.rebuild();
      },
      transferForEdit: (entry, cohort) => {
        const snapshots = cohort.flatMap((record) => (record.draft ? [record.draft] : []));
        if (snapshots.length !== cohort.length) return false;
        const source = composerSessionDraft(accountId, { kind: "chat", id: threadId });
        if (entry.creation && source.initialDraft) snapshots.push(source.initialDraft);
        const destination = entry.creation
          ? { kind: "new-chat" as const, id: projectId }
          : { kind: "chat" as const, id: threadId };
        if (!composerSessionDraft(accountId, destination).prependSnapshots(snapshots)) return false;
        if (entry.creation) {
          this.destination = "editing";
          source.handoff();
        }
        return true;
      },
      edited: (entry) => {
        if (entry.creation) {
          removeChatRow(queryClient, projectId, threadId);
          options.dissolveChat();
        } else
          requestAnimationFrame(() => {
            if (current()) options.focusComposer();
          });
      },
    });
  }

  private entries() {
    return this.options.current()
      ? readChatSubmissions(this.options.accountId).filter(
          (entry) => entry.threadId === this.options.threadId,
        )
      : [];
  }

  rebuild = () => {
    const { current, accountId, threadId, actions } = this.options;
    if (!current()) return;
    const snapshot = readChatSubmissionSnapshot(accountId);
    if (!snapshot) return;
    const records = snapshot.filter((entry) => entry.threadId === threadId);
    if (this.destination !== "editing" && records.some((entry) => entry.creation))
      this.destination = "creating";
    else if (records.length > 0) this.destination = "created";
    if (!records.length && this.destination === "creating") {
      void this.reconcileDestination();
      return;
    }
    this.presentation = new Map();
    const ids = new Set(records.map((entry) => key(accountId, entry.recordId)));
    let retired = false;
    for (const [id, row] of rows) {
      if (!id.startsWith(`${accountId}:`) || row.threadId !== threadId || ids.has(id)) continue;
      actions.removeOptimisticUserTurn(threadId, row.turnId);
      this.options.clear(id.slice(accountId.length + 1));
      rows.delete(id);
      retired = true;
    }
    for (const entry of records) {
      const row = projectRow(accountId, entry, actions);
      const failure = row.status ? row.status === "error" : row.failed || entry.state;
      actions.patchTurnStatus(threadId, row.turnId, failure ? "error" : "pending");
      if (!failure) continue;
      this.presentation.set(row.turnId, {
        onRetry: () => {
          void this.driver.retry(entry.submissionId);
        },
        ...(entry.state === "rejected" && entry.draft && !row.localFailure
          ? {
              busy: row.busy,
              onEdit: () => {
                if (row.busy) return;
                row.busy = true;
                this.rebuild();
                void this.driver.edit(entry.submissionId).finally(() => {
                  row.busy = false;
                  this.rebuild();
                });
              },
            }
          : {}),
      });
    }
    if (retired) actions.invalidateThreadSnapshot(threadId);
    this.options.changed();
  };

  /** Absence is not dissolution. Resolve remote Edit versus acceptance from the server. */
  private async reconcileDestination() {
    if (this.reconciling) return;
    this.reconciling = true;
    const { accountId, threadId, projectId, signal, current, actions, queryClient } = this.options;
    const timeout = AbortSignal.timeout(15_000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    try {
      const snapshot = await abortable(
        getThreadSnapshot({ data: { threadId }, signal: requestSignal }),
        requestSignal,
      );
      if (!current()) return;
      this.destination = "created";
      actions.ensureThread(deserializeThreadSnapshot(snapshot).thread);
      this.rebuild();
    } catch (error) {
      if (!current()) return;
      if (error instanceof HttpResponseError && error.status === 404) {
        // A newer addressed intent may have arrived while confirmation was in flight.
        const records = readChatSubmissionSnapshot(accountId);
        if (!records || records.some((entry) => entry.threadId === threadId)) return;
        const source = composerSessionDraft(accountId, { kind: "chat", id: threadId });
        if (
          source.initialDraft &&
          !composerSessionDraft(accountId, { kind: "new-chat", id: projectId }).prependSnapshots([
            source.initialDraft,
          ])
        )
          return;
        source.handoff();
        this.destination = "editing";
        this.rebuild();
        removeChatRow(queryClient, projectId, threadId);
        this.options.dissolveChat();
      }
      // Network failures and unavailable reads keep the destination and last-known rows.
    } finally {
      this.reconciling = false;
    }
  }

  submit = async (envelope: ComposerSubmitEnvelope): Promise<boolean> => {
    const { accountId, threadId, projectId, actions, current } = this.options;
    if (!current()) return false;
    const creation = this.entries().find((entry) => entry.creation)?.creation;
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
    if (!recordAndProjectSubmission(accountId, entry, actions)) return false;
    void this.driver.drive(threadId);
    return true;
  };

  rowActions = (turnId: string): UserTurnRecovery | null => this.presentation.get(turnId) ?? null;
  dispose() {
    this.options.controller.endRecoverySession(this.session);
  }
}
