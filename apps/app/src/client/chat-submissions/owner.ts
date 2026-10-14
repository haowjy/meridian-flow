/** Tab submission model: durable handoff, row projection, and writer commands. */
import type { AiWriteMode } from "@meridian/contracts/works";
import type { QueryClient } from "@tanstack/react-query";
import { HttpResponseError } from "@/client/api/http-client";
import { createProjectThread } from "@/client/api/projects-api";
import {
  deserializeThreadSnapshot,
  enqueueThreadControl,
  getThreadSnapshot,
} from "@/client/api/threads-api";
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
import { cleanDeletedChat } from "./deleted-chat";
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
import {
  type ChatSubmission,
  type ControlAnswer,
  compareSubmissions,
  type NewChatSubmission,
} from "./store";
import { threadAvailability } from "./thread-availability";

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
type RecoveryState = {
  recordId: string;
  submissionId: string;
  editable?: boolean;
  busy?: boolean;
  moving?: boolean;
};
/** A write-mode switch the journal still holds: unanswered, or answered with the stamp. */
export type JournalSwitch = {
  id: string;
  mode: AiWriteMode;
  /** The record's place in the chat's order. */
  seq: number;
  /** Marked posted before its first request left. */
  posted: boolean;
  /** The server refused it: nothing is held there, so Withdraw is local. */
  refused: boolean;
  /** The last attempt did not succeed (refused, or lost in this tab). */
  failed: boolean;
  /** The server's answer, stamped by whichever tab drove the record. */
  answer: ControlAnswer | null;
};
type ThreadModel = {
  epoch: number;
  rows: Map<string, Row>;
  presentation: Map<string, RecoveryState>;
  bindings: Set<ChatSubmissionOwner>;
  /** Records of switches whose last attempt in this tab did not reach the server. */
  failedSwitches: Set<string>;
  switches: readonly JournalSwitch[];
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
      failedSwitches: new Set(),
      switches: [],
    };
    models.set(id, model);
  }
  return model;
}
const key = (accountId: string, recordId: string) => `${accountId}:${recordId}`;

function projectRow(accountId: string, entry: NewChatSubmission, actions: ThreadStoreActions): Row {
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
  entry: NewChatSubmission,
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
          aiWriteMode: entry.creation.aiWriteMode ?? entry.creation.workAiWriteMode,
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
  /** A switch the server did not take; announce it where the writer can hear it. */
  failedSwitch(entry: ChatSubmission): void;
  clear(recordId: string): void;
  focusComposer(): void;
  dissolveChat(): void;
};

export class ChatSubmissionOwner {
  readonly driver: ChatSubmissionDriver;
  private readonly model: ThreadModel;
  /** Shared eligibility/status, with commands bound only at the invoking pane. */
  get presentation(): ReadonlyMap<string, UserTurnRecovery> {
    return new Map(
      [...this.model.presentation].map(([turnId, state]) => [
        turnId,
        {
          busy: state.busy,
          moving: state.moving,
          ...(!state.moving ? { onRetry: () => this.retry(turnId) } : {}),
          ...(state.editable ? { onEdit: () => this.edit(turnId) } : {}),
        },
      ]),
    );
  }

  private retry(turnId: string) {
    const state = this.model.presentation.get(turnId);
    if (!this.options.current() || !state || state.moving) return;
    void this.driver.retry(state.submissionId);
  }

  private edit(turnId: string) {
    const state = this.model.presentation.get(turnId);
    if (!this.options.current() || !state?.editable || state.busy) return;
    const row = this.model.rows.get(key(this.options.accountId, state.recordId));
    if (!row) return;
    row.busy = true;
    this.rebuild();
    void this.driver.edit(state.submissionId).finally(() => {
      row.busy = false;
      this.rebuild();
    });
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
      deleted: (entry, reason) =>
        cleanDeletedChat(accountId, threadId, projectId, reason, undefined, true),
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
            ...(entry.creation.aiWriteMode ? { aiWriteMode: entry.creation.aiWriteMode } : {}),
            agentSelection: entry.creation.agentSelection,
          },
          { signal: requestSignal },
        );
      },
      postControl: (entry, requestSignal) => {
        if (!entry.control) throw new Error("Control missing");
        return enqueueThreadControl(
          threadId,
          {
            id: entry.submissionId,
            control: { kind: entry.control.kind, mode: entry.control.mode },
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
        if (entry.control) {
          // A switch has no writer row: only its queued row (`switches`) shows the state.
          if (status === "error") {
            if (!this.model.failedSwitches.has(entry.recordId)) options.failedSwitch(entry);
            this.model.failedSwitches.add(entry.recordId);
          } else {
            this.model.failedSwitches.delete(entry.recordId);
            options.clear(entry.recordId);
          }
          this.rebuild();
          return;
        }
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
        if (entry.control) return this.rebuild();
        const row = rows.get(key(accountId, entry.recordId));
        if (row?.attempt?.session === this.session) row.attempt = undefined;
        this.rebuild();
      },
      transferReceived: (entry) => this.transferDestination(entry).hasReceived(entry.recordId),
      transferForEdit: (entry, cohort) => {
        // Only messages carry words; a switch in the cohort leaves with them and has no draft.
        const messages = cohort.filter((record) => !record.control);
        const snapshots = messages.flatMap((record) => (record.draft ? [record.draft] : []));
        if (snapshots.length !== messages.length) return false;
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
            messages.map((record) => record.recordId),
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

  get switches(): readonly JournalSwitch[] {
    return this.model.switches;
  }

  /**
   * Record a switch in the journal after everything the writer did before it, and drive.
   * It carries the chat's creation inputs like a message does, so a switch made
   * while navigate-first creation is in flight waits behind it in the same order.
   */
  submitSwitch = (id: string, mode: AiWriteMode): boolean => {
    const { accountId, threadId, projectId, current } = this.options;
    if (!current()) return false;
    const entry: NewChatSubmission = {
      recordId: id,
      submissionId: id,
      threadId,
      projectId,
      createdAt: new Date().toISOString(),
      text: "",
      blocks: [],
      references: [],
      activatedSkillSlugs: [],
      control: { kind: "write_mode", mode },
      creation: this.entries().find((record) => record.creation)?.creation,
    };
    if (!recordChatSubmission(accountId, entry)) return false;
    void this.driver.drive(threadId);
    return true;
  };

  retrySwitch = (id: string) => {
    if (this.options.current()) void this.driver.retry(id);
  };

  withdrawSwitch = (id: string) => this.driver.withdrawControl(id, this.options.threadId);

  shownRecordIds = () =>
    new Set([...this.model.rows.keys()].map((id) => id.slice(this.options.accountId.length + 1)));

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
    this.rebuildSwitches(records);
    for (const entry of records) {
      if (entry.control) continue;
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
      this.model.presentation.set(row.turnId, {
        recordId: entry.recordId,
        submissionId: entry.submissionId,
        moving,
        busy: moving || row.busy,
        editable: !moving && entry.state === "rejected" && !!entry.draft && !row.localFailure,
      });
    }
    if (retired) actions.invalidateThreadSnapshot(threadId);
    for (const binding of this.model.bindings)
      if (binding.options.current()) binding.options.changed();
  };

  /** The switches still in the journal, oldest first. A new array only when one changed. */
  private rebuildSwitches(records: readonly ChatSubmission[]) {
    const found = records.filter((entry) => entry.control).sort(compareSubmissions);
    const failed = this.model.failedSwitches;
    for (const id of failed) {
      if (found.some((entry) => entry.recordId === id)) continue;
      // Withdrawn or retired: its "Couldn't switch" announcement ends with it.
      failed.delete(id);
      this.options.clear(id);
    }
    const next: JournalSwitch[] = found.map((entry) => ({
      id: entry.recordId,
      mode: entry.control?.mode ?? "direct",
      seq: entry.seq,
      posted: !!entry.posted,
      refused: entry.state === "rejected",
      failed: !entry.answer && (entry.state === "rejected" || failed.has(entry.recordId)),
      answer: entry.answer ?? null,
    }));
    const previous = this.model.switches;
    const same =
      previous.length === next.length &&
      previous.every((entry, index) => {
        const other = next[index];
        return (
          other !== undefined &&
          entry.id === other.id &&
          entry.mode === other.mode &&
          entry.seq === other.seq &&
          entry.posted === other.posted &&
          entry.refused === other.refused &&
          entry.failed === other.failed &&
          entry.answer?.seq === other.answer?.seq
        );
      });
    if (!same) this.model.switches = next;
  }

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
        if (!current()) return;
        const availability = threadAvailability(error, accountId);
        if (availability === "deleted" || availability === "project-deleted") {
          await cleanDeletedChat(accountId, threadId, projectId, availability);
          return;
        }
        if (!(error instanceof HttpResponseError && error.status === 404)) return;
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
    const entry: NewChatSubmission = {
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
