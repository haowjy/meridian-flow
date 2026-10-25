/** Tab submission model: durable handoff, row projection, and writer commands. */

import { type FailureEnd, type FailureLog, noFailureLog } from "@meridian/contracts/failures";
import type { AiWriteMode } from "@meridian/contracts/works";
import {
  type CommandFailure,
  type JournalSwitch,
  logCommandFailure,
  nextOccurrence,
  type Occurrence,
  occurrenceKey,
} from "@meridian/thread-client";
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
  invalidateWriteModeReads,
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
import { type ChatSubmission, compareSubmissions, type NewChatSubmission } from "./store";
import { threadAvailability } from "./thread-availability";

type Row = {
  threadId: string;
  turnId: string;
  fresh: boolean;
  failed?: boolean;
  localFailure?: boolean;
  failure?: CommandFailure;
  busy?: boolean;
  status?: "error";
  attempt?: { session: object; submissionId: string; signal: AbortSignal };
};
type RecoveryState = {
  failure: CommandFailure;
  recordId: string;
  submissionId: string;
  editable?: boolean;
  busy?: boolean;
  moving?: boolean;
};
type ThreadModel = {
  epoch: number;
  rows: Map<string, Row>;
  presentation: Map<string, RecoveryState>;
  bindings: Set<ChatSubmissionOwner>;
  /** Records of switches whose last attempt in this tab did not reach the server. */
  failedSwitches: Map<string, CommandFailure>;
  switches: readonly JournalSwitch[];
  unsavedSwitches: Map<string, { mode: AiWriteMode; seq: number; occurrence: Occurrence }>;
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
      failedSwitches: new Map(),
      switches: [],
      unsavedSwitches: new Map(),
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
  failureLog?: FailureLog;
  accountId: string;
  threadId: string;
  projectId: string;
  signal: AbortSignal;
  current(): boolean;
  controller: ThreadRunController;
  actions: ThreadStoreActions;
  queryClient: QueryClient;
  changed(): void;
  focusComposer(): void;
  dissolveChat(): void;
};

export class ChatSubmissionOwner {
  readonly driver: ChatSubmissionDriver;
  private readonly model: ThreadModel;
  /** Shared eligibility/status, with commands bound only at the invoking pane. */
  private recovery = new Map<string, UserTurnRecovery>();
  get presentation(): ReadonlyMap<string, UserTurnRecovery> {
    return this.recovery;
  }

  private publishPresentation() {
    this.recovery = new Map(
      [...this.model.presentation].map(([turnId, state]) => [
        turnId,
        {
          busy: state.busy,
          moving: state.moving,
          failure: state.failure,
          ...(!state.moving ? { onRetry: () => this.retry(turnId) } : {}),
          ...(state.editable ? { onEdit: () => this.edit(turnId) } : {}),
        },
      ]),
    );
    this.options.changed();
  }

  private log(failure: CommandFailure | undefined, end?: FailureEnd, turnId?: string) {
    if (failure)
      logCommandFailure(
        this.options.failureLog ?? noFailureLog,
        failure,
        { threadId: this.options.threadId, ...(turnId ? { turnId } : {}) },
        end,
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
      deleted: (_entry, reason) =>
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
        ).then((response) => {
          // The list rows carry the pending mode (`effectiveAiWriteMode`); a queued or cancelled
          // switch changes it, and the toolbar reads it before the snapshot lands.
          void invalidateWriteModeReads(queryClient, projectId);
          return response;
        });
      },
      created: (thread) => {
        this.destination = "created";
        actions.ensureThread(thread);
        void invalidateProjectThreadData(queryClient, projectId);
        if (thread.workId) void invalidateWorkThreads(queryClient, projectId, thread.workId);
      },
      status: (entry, status, localFailure) => {
        const failure =
          status === "error"
            ? commandFailure(
                entry,
                localFailure ?? (entry.state === "rejected" ? "refused" : "lost"),
              )
            : undefined;
        if (entry.control) {
          // A switch has no writer row: only its queued row (`switches`) shows the state.
          const previous = this.model.failedSwitches.get(entry.recordId);
          if (previous && (!failure || occurrenceKey(previous) !== occurrenceKey(failure)))
            this.log(previous, "retried");
          if (failure) this.log(failure);
          if (failure) this.model.failedSwitches.set(entry.recordId, failure);
          else this.model.failedSwitches.delete(entry.recordId);
          this.rebuild();
          return;
        }
        const row = projectRow(accountId, entry, actions);
        if (row.failure && (!failure || occurrenceKey(row.failure) !== occurrenceKey(failure)))
          this.log(row.failure, "retried", row.turnId);
        if (failure) this.log(failure, undefined, row.turnId);
        row.status = status === "error" ? status : undefined;
        row.failure = failure;
        row.attempt =
          status === "pending"
            ? { session: this.session, submissionId: entry.submissionId, signal }
            : undefined;
        if (status === "error") {
          // A message moving to the message box is no failure; otherwise the failed row is a card.
          row.failed = !this.transferDestination(entry).hasReceived(entry.recordId);
          row.localFailure = !!localFailure;
        } else {
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
        const recordIds = messages.map((record) => record.recordId);
        if (
          !(entry.creation
            ? target.recoverCreation(entry.threadId, snapshots, recordIds)
            : target.prependSnapshots(snapshots, recordIds))
        )
          return false;
        for (const record of cohort) {
          const row = rows.get(key(accountId, record.recordId));
          this.log(row?.failure, "dismissed", row?.turnId);
          this.log(this.model.failedSwitches.get(record.recordId), "dismissed");
        }
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
    const previous = this.model.unsavedSwitches.get(id);
    if (previous) this.log({ ...previous.occurrence, kind: "unsaved" }, "retried");
    const occurrence = nextOccurrence(previous?.occurrence.attempt ?? 0, crypto.randomUUID());
    const entry: NewChatSubmission = {
      occurrence,
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
    if (!recordChatSubmission(accountId, entry)) {
      const seq =
        this.model.unsavedSwitches.get(id)?.seq ??
        Math.max(0, ...this.model.switches.map((row) => row.seq)) + 1;
      this.log({ ...occurrence, kind: "unsaved" });
      this.model.unsavedSwitches.set(id, { mode, seq, occurrence });
      this.publishSwitches();
      return false;
    }
    this.model.unsavedSwitches.delete(id);
    this.publishSwitches();
    void this.driver.drive(threadId);
    return true;
  };

  retrySwitch = (id: string) => {
    if (!this.options.current()) return;
    const unsaved = this.model.unsavedSwitches.get(id);
    if (unsaved) this.submitSwitch(id, unsaved.mode);
    else void this.driver.retry(id);
  };

  withdrawSwitch = (id: string) => {
    const unsaved = this.model.unsavedSwitches.get(id);
    if (this.options.current() && unsaved && this.model.unsavedSwitches.delete(id)) {
      this.log({ ...unsaved.occurrence, kind: "unsaved" }, "dismissed");
      this.publishSwitches();
      return Promise.resolve("removed" as const);
    }
    this.log(this.model.failedSwitches.get(id), "dismissed");
    return this.driver.withdrawControl(id, this.options.threadId);
  };

  private publishSwitches() {
    this.rebuildSwitches(this.entries());
    for (const binding of this.model.bindings)
      if (binding.options.current()) binding.publishPresentation();
  }

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
    if (!current()) {
      if (this.epoch !== getChatSubmissionEpoch()) this.endAccountFailures();
      return;
    }
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
      this.log(row.failure, "resolved", row.turnId);
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
      const nextFailure = latestFailure(entry, row.failure);
      if (row.failure && occurrenceKey(row.failure) !== occurrenceKey(nextFailure))
        this.log(row.failure, "retried", row.turnId);
      row.failure = nextFailure;
      this.log(nextFailure, undefined, row.turnId);
      if (moving) this.log(nextFailure, "dismissed", row.turnId);
      this.model.presentation.set(row.turnId, {
        recordId: entry.recordId,
        submissionId: entry.submissionId,
        failure: latestFailure(entry, row.failure),
        moving,
        busy: moving || row.busy,
        editable: !moving && entry.state === "rejected" && !!entry.draft && !row.localFailure,
      });
    }
    if (retired) actions.invalidateThreadSnapshot(threadId);
    for (const binding of this.model.bindings)
      if (binding.options.current()) binding.publishPresentation();
  };

  /** The switches still in the journal, oldest first. A new array only when one changed. */
  private rebuildSwitches(records: readonly ChatSubmission[]) {
    const found = records.filter((entry) => entry.control).sort(compareSubmissions);
    const failed = this.model.failedSwitches;
    for (const id of failed.keys()) {
      if (found.some((entry) => entry.recordId === id && !entry.answer)) continue;
      // Withdrawn, answered by another tab, or retired: its "Couldn't switch" card ends.
      this.log(failed.get(id), "resolved");
      failed.delete(id);
    }
    for (const entry of found)
      if (!entry.answer && entry.state === "rejected") {
        const previous = failed.get(entry.recordId);
        const next = latestFailure(entry, previous);
        if (previous && occurrenceKey(previous) !== occurrenceKey(next))
          this.log(previous, "retried");
        failed.set(entry.recordId, next);
        this.log(next);
      }
    const next: JournalSwitch[] = found.map((entry) => ({
      id: entry.recordId,
      mode: entry.control?.mode ?? "direct",
      seq: entry.seq,
      posted: !!entry.posted,
      refused: entry.state === "rejected",
      answer: entry.answer ?? null,
      ...(!entry.answer && (entry.state === "rejected" || failed.has(entry.recordId))
        ? {
            failed: true,
            failure: latestFailure(entry, failed.get(entry.recordId)),
          }
        : { failed: false }),
    }));
    for (const [id, { mode, seq, occurrence }] of this.model.unsavedSwitches) {
      if (found.some((record) => record.recordId === id)) {
        this.log({ ...occurrence, kind: "unsaved" }, "resolved");
        this.model.unsavedSwitches.delete(id);
        continue;
      }
      next.push({
        id,
        mode,
        seq,
        posted: false,
        refused: false,
        failed: true,
        answer: null,
        failure: { ...occurrence, kind: "unsaved" },
      });
    }
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
          entry.failure?.requestId === other.failure?.requestId &&
          entry.failure?.attempt === other.failure?.attempt &&
          entry.failure?.kind === other.failure?.kind &&
          entry.answer?.runState.version === other.answer?.runState.version
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
      const target = composerSessionDraft(accountId, { kind: "new-chat", id: projectId });
      // The server never had this chat, so the draft's uploads still belong to its id.
      if (source.initialDraft && !target.recoverCreation(threadId, [source.initialDraft])) return;
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

  private endAccountFailures() {
    for (const row of this.model.rows.values()) this.log(row.failure, "moot", row.turnId);
    for (const failure of this.model.failedSwitches.values()) this.log(failure, "moot");
    for (const { occurrence } of this.model.unsavedSwitches.values())
      this.log({ ...occurrence, kind: "unsaved" }, "moot");
  }

  dispose() {
    if (this.epoch !== getChatSubmissionEpoch()) this.endAccountFailures();
    this.options.controller.endRecoverySession(this.session);
    this.model.bindings.delete(this);
    for (const row of this.model.rows.values())
      if (row.attempt?.session === this.session) row.attempt = undefined;
    const binding = [...this.model.bindings].find((owner) => owner.options.current());
    binding?.rebuild();
  }
}

function commandFailure(entry: ChatSubmission, kind: CommandFailure["kind"]): CommandFailure {
  return {
    ...(entry.occurrence ?? { requestId: entry.submissionId, attempt: 1 }),
    submissionId: entry.submissionId,
    kind,
  };
}

/** A newer attempt is not evidence of failure; only its durable refusal can replace local facts. */
function latestFailure(entry: ChatSubmission, local?: CommandFailure): CommandFailure {
  return local && (entry.state !== "rejected" || local.attempt >= (entry.occurrence?.attempt ?? 0))
    ? local
    : commandFailure(entry, entry.state === "rejected" ? "refused" : "lost");
}
