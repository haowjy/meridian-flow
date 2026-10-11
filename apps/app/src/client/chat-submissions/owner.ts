/** Tab submission model: durable handoff, row projection, and writer commands. */
import type { QueryClient } from "@tanstack/react-query";
import { HttpResponseError } from "@/client/api/http-client";
import { createProjectThread } from "@/client/api/projects-api";
import { deserializeThreadSnapshot, getThreadSnapshot } from "@/client/api/threads-api";
import { type ComposerDraftScope, composerSessionDraft } from "@/client/composer-drafts";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import { removeChatRow } from "@/client/query/chat-projections";
import {
  invalidateProjectThreadData,
  invalidateWorkThreads,
} from "@/client/query/project-invalidation";
import type { ThreadStoreActions } from "@/client/stores";
import type { ComposerSubmitEnvelope } from "@/components/app/composer";
import { whenDerived } from "@/features/chat/derivation/derive-conversation";
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
import type { UserTurnRecovery } from "./presentation";
import type { ChatSubmission } from "./store";

type Row = {
  threadId: string;
  turnId: string;
  fresh: boolean;
  failed?: boolean;
  localFailure?: boolean;
  busy?: boolean;
  status?: "error";
  attempt?: { session: object; submissionId: string; signal: AbortSignal };
};
type ThreadModel = {
  epoch: number;
  rows: Map<string, Row>;
  presentation: Map<string, UserTurnRecovery>;
  bindings: Set<ChatSubmissionOwner>;
};
const models = new Map<string, ThreadModel>();
function threadModel(accountId: string, threadId: string): ThreadModel {
  const id = JSON.stringify([accountId, threadId]);
  let model = models.get(id);
  if (!model || model.epoch !== getChatSubmissionEpoch()) {
    model = {
      epoch: getChatSubmissionEpoch(),
      rows: new Map(),
      presentation: new Map(),
      bindings: new Set(),
    };
    models.set(id, model);
  }
  return model;
}
const key = (accountId: string, recordId: string) => `${accountId}:${recordId}`;

function projectRow(accountId: string, entry: ChatSubmission, actions: ThreadStoreActions): Row {
  const rows = threadModel(accountId, entry.threadId).rows;
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
  scope: ComposerDraftScope,
): boolean {
  if (!recordChatSubmission(accountId, entry)) return false;
  if (entry.draft) composerSessionDraft(accountId, scope).handoffSubmitted(entry.draft);
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
  private readonly model: ThreadModel;
  get presentation() {
    return this.model.presentation;
  }
  private readonly session = {};
  private destination: "unknown" | "creating" | "created" | "editing" = "unknown";
  private reconciling = false;
  private readonly epoch = getChatSubmissionEpoch();
  constructor(private readonly options: OwnerOptions) {
    const { accountId, threadId, projectId, signal, current, controller, actions, queryClient } =
      options;
    this.model = threadModel(accountId, threadId);
    this.model.bindings.add(this);
    const rows = this.model.rows;
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
        row.status = status === "error" ? status : undefined;
        row.attempt =
          status === "pending"
            ? { session: this.session, submissionId: entry.submissionId, signal }
            : undefined;
        if (status === "error") {
          if (this.transferDestination(entry).hasReceived(entry.recordId)) {
            options.clear(entry.recordId);
            row.failed = false;
          } else {
            if (!row.failed) options.failed(entry.recordId);
            row.failed = true;
          }
          row.localFailure = localFailure ?? false;
        } else {
          options.clear(entry.recordId);
          row.failed = false;
        }
        actions.patchTurnStatus(threadId, row.turnId, status);
        this.rebuild();
      },
      finished: (entry) => {
        const row = rows.get(key(accountId, entry.recordId));
        if (row?.attempt?.session === this.session) row.attempt = undefined;
        this.rebuild();
      },
      transferReceived: (entry) => this.transferDestination(entry).hasReceived(entry.recordId),
      transferForEdit: (entry, cohort) => {
        const snapshots = cohort.flatMap((record) => (record.draft ? [record.draft] : []));
        if (snapshots.length !== cohort.length) return false;
        const source = composerSessionDraft(accountId, { kind: "chat", id: threadId });
        const target = this.transferDestination(entry);
        if (
          entry.creation &&
          source.initialDraft &&
          !cohort.some((record) => target.hasReceived(record.recordId))
        )
          snapshots.push(source.initialDraft);
        if (
          !target.prependSnapshots(
            snapshots,
            cohort.map((record) => record.recordId),
          )
        )
          return false;
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

  private transferDestination(entry: ChatSubmission) {
    return composerSessionDraft(this.options.accountId, {
      kind: entry.creation ? "new-chat" : "chat",
      id: entry.creation ? this.options.projectId : entry.threadId,
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
    if (this.destination !== "editing") {
      if (records.some((entry) => entry.creation)) this.destination = "creating";
      else if (records.length > 0) this.destination = "created";
    }
    if (!records.length && this.destination === "creating") {
      void this.reconcileDestination();
      return;
    }
    const rows = this.model.rows;
    this.model.presentation = new Map();
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
      const pending =
        row.attempt &&
        !row.attempt.signal.aborted &&
        row.attempt.submissionId === entry.submissionId;
      if (!pending) row.attempt = undefined;
      const moving = this.transferDestination(entry).hasReceived(entry.recordId);
      const failure = moving || (!pending && (row.status === "error" || row.failed || entry.state));
      actions.patchTurnStatus(threadId, row.turnId, failure ? "error" : "pending");
      if (!failure) continue;
      if (moving) {
        this.presentation.set(row.turnId, { busy: true, moving: true });
        continue;
      }
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
    for (const binding of this.model.bindings)
      if (binding.options.current()) binding.options.changed();
  };

  /** Absence is not dissolution. Resolve remote Edit versus acceptance from the server. */
  private async reconcileDestination() {
    if (this.reconciling) return;
    this.reconciling = true;
    const { accountId, threadId, projectId, signal, current, actions, queryClient } = this.options;
    const timeout = AbortSignal.timeout(15_000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    const destination = this.destination;
    try {
      let snapshot: Awaited<ReturnType<typeof getThreadSnapshot>> | undefined;
      let missing = false;
      try {
        snapshot = await abortable(
          getThreadSnapshot({ data: { threadId }, signal: requestSignal }),
          requestSignal,
        );
      } catch (error) {
        if (!current() || !(error instanceof HttpResponseError && error.status === 404)) return;
        missing = true;
      }
      if (!current()) return;
      if (!missing) {
        if (!snapshot) throw new Error("Thread snapshot response is empty");
        const thread = deserializeThreadSnapshot(snapshot).thread;
        actions.ensureThread(thread);
        this.destination = "created";
        this.rebuild();
        return;
      }
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
    } catch (error) {
      this.destination = destination;
      reportError(error);
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
    if (!recordAndProjectSubmission(accountId, entry, actions, { kind: "chat", id: threadId }))
      return false;
    void this.driver.drive(threadId);
    return true;
  };

  dispose() {
    this.options.controller.endRecoverySession(this.session);
    this.model.bindings.delete(this);
    for (const row of this.model.rows.values())
      if (row.attempt?.session === this.session) row.attempt = undefined;
    const binding = [...this.model.bindings].find((owner) => owner.options.current());
    binding?.rebuild();
  }
}
