/** Shared delivery transitions. Concrete adapters supply one compatible transaction/store bundle. */
import type { ProjectId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { isPendingPlaceholder } from "@meridian/contracts/threads";
import type { NoticePort } from "../../notices/index.js";
import { loadThreadConversationContext, SystemUpdateMetadataCodec } from "../../threads/index.js";
import { nextTurnPosition } from "../../threads/order-turns.js";
import type { DetachedWorkTracker } from "../detached-work.js";
import { finalizeExecution } from "../loop/execution-finalizer.js";
import { drainInbox, planMessageTurns } from "../loop/inbox-context.js";
import { currentTurnKind, reservationTurn } from "../loop/local-turn.js";
import { next } from "../loop/next-inbox-work.js";
import { finalizeOrphanedTurns } from "../loop/orphaned-placeholder.js";
import { readPendingInbox } from "../loop/pending-inbox.js";
import {
  type PersistenceDeps,
  persistAndAppendEvents,
  persistAndAppendTurnStartEvents,
} from "../loop/persistence.js";
import type {
  InboxMessage,
  InboxReader,
  Lease,
  MessageDraft,
  RunClaim,
  RunStarter,
} from "../loop/ports.js";
import { writerFacingPreparationError } from "../loop/preparation-failure.js";
import { NoPendingWakeError } from "../loop/run-turn-port.js";
import type {
  AdoptedBatch,
  DeliveryBoundary,
  DeliveryBoundarySelection,
  DeliverySelection,
  DeliverySelectionFields,
  RuntimeDelivery,
} from "../loop/runtime-delivery.js";
import { createThreadControls } from "../loop/thread-controls.js";
import type { ThreadLock } from "../loop/thread-lock.js";

/** Adapter-private storage primitives; never injected into the model loop or producers. */
export interface DeliveryStore extends InboxReader {
  findMessage(id: string): Promise<InboxMessage | null>;
  workNoticeTargets(projectId: ProjectId): Promise<ThreadId[]>;
  canMaterializeWork(threadId: ThreadId): Promise<boolean>;
  pendingWorkThreads(limit: number, afterThreadId?: ThreadId): Promise<ThreadId[]>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  ack(threadId: ThreadId, ids: string[]): Promise<void>;
}

export interface DeliveryLeaseStore {
  cancelThreadReceipt(threadId: ThreadId, turnId: TurnId): Promise<boolean>;
  lockThreadReceipt(threadId: ThreadId): Promise<{ ids: string[]; turnId: TurnId | null } | null>;
  bindTurn(
    lease: Lease,
    turnId: TurnId,
    ids: readonly string[],
    kind: "assistant" | "compaction",
  ): Promise<void>;
  setAdoptedMessageIds(lease: Lease, ids: readonly string[]): Promise<boolean>;
  clearReceipt(lease: Lease, expectedIds: readonly string[]): Promise<boolean>;
  clearOrphanedReceipt(
    threadId: ThreadId,
    turnId: TurnId,
    expectedIds: readonly string[],
  ): Promise<boolean>;
  lockReceipt(lease: Lease): Promise<{ ids: string[]; cancelRequested: boolean } | null>;
}

const PREPARATION_ATTEMPTS = 3;

export function createDeliveryAdapter(
  deps: PersistenceDeps & {
    backgroundTasks: DetachedWorkTracker;
    repos: import("../../threads/index.js").ThreadRepositories;
    toolRegistry?: Pick<import("../tools/types.js").ToolRegistry, "getRegistration">;
    inbox: DeliveryStore;
    leaseStore: DeliveryLeaseStore;
    runClaim: Pick<RunClaim, "release" | "withExclusiveThread" | "cancelExecution">;
    publishFinalizedReports(reports: readonly SavedExecutionReport[]): Promise<void>;
    workContext: import("../loop/work-context.js").WorkContextReader;
    threadLock: ThreadLock;
    notices: NoticePort;
    runStarter: RunStarter;
    schedulePostCommit(task: () => Promise<void>): void;
    publishStatus?(threadId: ThreadId): Promise<void>;
  },
): RuntimeDelivery {
  const { inbox, leaseStore, threadLock } = deps;
  const backgroundTasks = deps.backgroundTasks;
  const schedulePostCommit = (task: () => Promise<void>) =>
    deps.schedulePostCommit(() =>
      backgroundTasks.track(Promise.resolve().then(task), "runtime delivery callback"),
    );
  const appendPending = async (threadId: ThreadId) => {
    await deps.eventWriter.appendEvent(threadId, {
      type: "inbox.changed",
      threadId,
      pending: await readPendingInbox(inbox, threadId),
    });
  };
  const clearOrphanedTurn = async (threadId: ThreadId, turnId: TurnId) => {
    const receipt = await leaseStore.lockThreadReceipt(threadId);
    if (!receipt || receipt.turnId !== turnId) return null;
    if (!(await leaseStore.clearOrphanedReceipt(threadId, turnId, receipt.ids))) {
      throw new Error("Cannot clear orphaned run receipt after it changed");
    }
    return receipt.ids;
  };
  const retireOrphanedReply = async (threadId: ThreadId, turnId: TurnId) => {
    const ids = await clearOrphanedTurn(threadId, turnId);
    if (!ids) return;
    await inbox.ack(threadId, ids);
    await appendPending(threadId);
  };
  const clearOrphanedTurnForRepair = async (threadId: ThreadId, turnId: TurnId) => {
    await clearOrphanedTurn(threadId, turnId);
  };
  type SelectedDelivery<TSelection> = {
    selection: TSelection;
    pendingBatch: InboxMessage[];
    work: Awaited<ReturnType<typeof workBatch>>;
  };
  async function selectForPreparation(
    threadId: ThreadId,
    at: "run_start",
    failedControlIds?: ReadonlySet<string>,
  ): Promise<SelectedDelivery<DeliverySelection>>;
  async function selectForPreparation(
    threadId: ThreadId,
    at: "boundary",
  ): Promise<SelectedDelivery<DeliveryBoundarySelection>>;
  async function selectForPreparation(
    threadId: ThreadId,
    at: "run_start" | "boundary",
    failedControlIds: ReadonlySet<string> = new Set(),
  ): Promise<SelectedDelivery<DeliverySelection | DeliveryBoundarySelection>> {
    const pendingBatch = await inbox.selectPending(threadId);
    const projection = await inbox.readPendingProjection(threadId);
    const boundIds = new Set(projection.run?.messageIds ?? []);
    const eligible = pendingBatch.filter((row) => !boundIds.has(row.id));
    const nextWork = next(eligible, at);
    const control = at === "run_start" && nextWork.kind === "control" ? nextWork.control : null;
    const rows = nextWork.kind === "none" ? [] : nextWork.rows;
    const selectedIds = new Set([...rows.map((row) => row.id), ...(control ? [control.id] : [])]);
    const work = await workBatch(threadId, rows);
    const [notices, thread] = await Promise.all([
      deps.notices.peek(threadId),
      deps.repos.threads.findById(threadId),
    ]);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const selectionFields = {
      batch: work.batch,
      outstanding: pendingBatch.filter(
        (row) => row.intent === "message" && (boundIds.has(row.id) || selectedIds.has(row.id)),
      ),
      deferred: pendingBatch.filter((row) => !boundIds.has(row.id) && !selectedIds.has(row.id)),
      workContext: work.workContext,
      notices,
      activeLeafTurnId: thread.activeLeafTurnId,
    };
    const selection: DeliverySelection | DeliveryBoundarySelection =
      at === "run_start"
        ? { ...selectionFields, next: nextWork, failedControlIds }
        : selectionFields;
    return { selection, pendingBatch, work };
  }
  async function selectionStillCurrent(
    threadId: ThreadId,
    selected: SelectedDelivery<DeliverySelectionFields>,
  ) {
    const [allPending, thread] = await Promise.all([
      inbox.selectPending(threadId),
      deps.repos.threads.findById(threadId),
    ]);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return (
      thread.activeLeafTurnId === selected.selection.activeLeafTurnId &&
      sameInboxBatch(allPending, selected.pendingBatch)
    );
  }

  async function prepareAndCommit<
    TSelection extends DeliverySelection | DeliveryBoundarySelection,
    TPrepared,
    TResult,
  >(input: {
    threadId: ThreadId;
    select: (failedControlIds: ReadonlySet<string>) => Promise<SelectedDelivery<TSelection>>;
    retryControlId?: (selection: TSelection) => string | null;
    signal?: AbortSignal;
    validate?: () => Promise<void>;
    prepare: (
      selection: TSelection,
      work: Awaited<ReturnType<typeof workBatch>>,
    ) => Promise<TPrepared>;
    hasPreparationFailure: (prepared: TPrepared) => boolean;
    commit: (
      selection: TSelection,
      work: Awaited<ReturnType<typeof workBatch>>,
      prepared: TPrepared,
    ) => Promise<TResult>;
  }): Promise<TResult> {
    let committingControlId: string | undefined;
    let failedControlIds: ReadonlySet<string> = new Set();
    try {
      return await attemptPreparation();
    } catch (error) {
      if (input.signal?.aborted || !committingControlId) throw error;
      // Retire a command whose start transaction failed. Its fresh preparation
      // commits a failed C rather than leaving the command at the queue head.
      failedControlIds = new Set([committingControlId]);
      return attemptPreparation();
    }
    async function attemptPreparation(): Promise<TResult> {
      for (let attempt = 0; attempt < PREPARATION_ATTEMPTS; attempt += 1) {
        const lockedPreparation = attempt === PREPARATION_ATTEMPTS - 1;
        if (lockedPreparation) {
          return threadLock.withThreadLock(input.threadId, async () => {
            const selected = await input.select(failedControlIds);
            input.signal?.throwIfAborted();
            const prepared = await input.prepare(selected.selection, selected.work);
            input.signal?.throwIfAborted();
            await input.validate?.();
            return commitSelected(selected, prepared);
          });
        }

        const selected = await input.select(failedControlIds);
        input.signal?.throwIfAborted();
        const prepared = await input.prepare(selected.selection, selected.work);
        input.signal?.throwIfAborted();
        const result = await threadLock.withThreadLock(input.threadId, async () => {
          input.signal?.throwIfAborted();
          if (!(await selectionStillCurrent(input.threadId, selected)))
            return { retry: true as const };
          await input.validate?.();
          return { retry: false as const, value: await commitSelected(selected, prepared) };
        });
        if (!result.retry) return result.value;
      }
      throw new Error("Unreachable delivery preparation loop exit");
    }

    async function commitSelected(
      selected: SelectedDelivery<TSelection>,
      prepared: TPrepared,
    ): Promise<TResult> {
      committingControlId = input.retryControlId?.(selected.selection) ?? undefined;
      const result = await input.commit(selected.selection, selected.work, prepared);
      committingControlId = undefined;
      if (!input.hasPreparationFailure(prepared)) {
        await deps.notices.consume(selected.selection.notices.map(({ id }) => id));
      }
      return result;
    }
  }
  const enqueue = async (draft: MessageDraft) => {
    const message = await inbox.enqueue(draft);
    await appendPending(draft.threadId);
    if (draft.intent === "message" || draft.intent === "control")
      schedulePostCommit(() => deps.runStarter.start(draft.threadId));
    return message;
  };
  let workCursor: ThreadId | undefined;
  async function workBatch(threadId: ThreadId, batch: InboxMessage[]) {
    const ids = batch
      .filter((message) => message.body.kind === "work_context_refresh")
      .map(({ id }) => id);
    const visible = ids.length > 0 && (await inbox.canMaterializeWork(threadId));
    let first = true;
    return {
      ids: visible ? ids : [],
      workContext: visible ? await deps.workContext.renderForThread(threadId) : undefined,
      batch: batch.filter((message) => {
        if (message.body.kind !== "work_context_refresh") return true;
        if (!visible || !first) return false;
        first = false;
        return true;
      }),
    };
  }
  async function materializePrefix(threadId: ThreadId) {
    const { selection, work } = await selectForPreparation(threadId, "boundary");
    const turns = await Promise.all(
      work.batch.map((message) => deps.repos.turns.findById(message.id)),
    );
    const leaf = selection.activeLeafTurnId;
    const leafTurn = leaf ? await deps.repos.turns.findById(leaf) : null;
    if (leaf && !leafTurn) throw new Error(`Missing causal turn: ${leaf}`);
    const plan = planMessageTurns({
      threadId,
      batch: work.batch,
      workContext: work.workContext,
      prevTurnId: leaf,
      prevTurnPosition: leafTurn?.position ?? null,
      knownTurnIds: new Set(turns.flatMap((turn) => (turn ? [turn.id] : []))),
    });
    if (plan.events.length === 0) return;
    await persistAndAppendTurnStartEvents(deps, threadId, leaf, async () => ({
      result: undefined,
      events: plan.events,
    }));
    await inbox.ack(threadId, work.ids);
    await appendPending(threadId);
  }
  async function materializeIdle(threadId: ThreadId) {
    await deps.runClaim.withExclusiveThread(threadId, () =>
      threadLock.withThreadLock(threadId, async () => {
        const reports = await finalizeOrphanedTurns({ ...deps, retireOrphanedReply }, { threadId });
        schedulePostCommit(() => deps.publishFinalizedReports(reports));
        if (await inbox.canMaterializeWork(threadId)) await materializePrefix(threadId);
      }),
    );
    return (await inbox.selectPending(threadId)).some(
      (message) => message.body.kind === "work_context_refresh",
    )
      ? ("pending" as const)
      : ("delivered" as const);
  }
  async function threadChanged(threadId: ThreadId, mutationId = crypto.randomUUID()) {
    // Work mutations already hold Work rows. Taking the thread lock here would
    // invert turn persistence's thread → Work activity order. Immutable markers
    // need no overwrite lock; exact-ID ack leaves every concurrent insert pending.
    await inbox.enqueue({
      threadId,
      intent: "notice",
      provenance: { kind: "system", source: "work_context" },
      body: { kind: "work_context_refresh" },
      idempotencyKey: `work-context:${mutationId}`,
    });
  }
  type PreparedAdoption<TCurrent> = {
    batch: InboxMessage[];
    work: Awaited<ReturnType<typeof workBatch>>;
    committedWorkIds: string[];
    expectedLeaf: TurnId | null;
    expectedLeafPosition: number | null;
    drain: Awaited<ReturnType<typeof drainInbox>>;
    prepared: Awaited<ReturnType<DeliveryBoundary["prepareNextContext"]>>;
    split: boolean;
    preparationFailure?: unknown;
    preparedCurrent?: TCurrent;
    selection: DeliveryBoundarySelection;
  };

  async function prepareAdoption<TCurrent>(
    input: DeliveryBoundary<TCurrent>,
    selection: DeliveryBoundarySelection,
    work: Awaited<ReturnType<typeof workBatch>>,
  ): Promise<PreparedAdoption<TCurrent>> {
    const { lease } = input;
    const batch = selection.batch;
    const threadId = lease.threadId;
    // Writer enqueue can have persisted and acked an earlier Work prefix while
    // this run's provider request was in flight. Adopt that committed history too.
    const committed: InboxMessage[] = [];
    const committedWorkIds: string[] = [];
    const expectedLeaf = selection.activeLeafTurnId as TurnId | null;
    const expectedLeafTurn = expectedLeaf ? await deps.repos.turns.findById(expectedLeaf) : null;
    if (expectedLeaf && !expectedLeafTurn) throw new Error(`Missing causal turn: ${expectedLeaf}`);
    let leaf: TurnId | null = expectedLeaf;
    while (leaf && !input.knownTurnIds.has(leaf)) {
      const turn = await deps.repos.turns.findById(leaf);
      if (!turn) throw new Error(`Missing causal turn: ${leaf}`);
      if (isPendingPlaceholder(turn))
        throw new Error("Unexpected pending placeholder in adoption tail");
      const message = batch.find((entry) => entry.id === turn.id);
      const systemUpdate = SystemUpdateMetadataCodec.safeParse(turn.metadata);
      if (message) committed.unshift(message);
      else if (systemUpdate.success && systemUpdate.data.section === "work_context") {
        committedWorkIds.push(turn.id);
        // A writer's prefix transaction already acked this durable notice. Replay
        // its saved blocks, not a fresh render of the current Work state.
        committed.unshift({
          id: turn.id,
          threadId,
          seq: 0,
          intent: "notice",
          provenance: { kind: "system", source: "work_context" },
          body: { kind: "work_context_refresh" },
          idempotencyKey: turn.id,
          enqueuedAt: turn.createdAt,
          deliveredAt: turn.createdAt,
        });
      }
      leaf = (turn.prevTurnId as TurnId | null | undefined) ?? null;
    }
    const committedIds = new Set(committed.map((message) => message.id));
    const orderedBatch = [
      ...committed,
      ...batch.filter((message) => !committedIds.has(message.id)),
    ];
    // Notices are folded into the prepared history; no turn is completed or
    // reserved until all external context reads have finished.
    const split =
      !!work.workContext ||
      committedWorkIds.length > 0 ||
      selection.notices.length > 0 ||
      orderedBatch.some(
        (message) =>
          (message.intent === "message" && !input.knownTurnIds.has(message.id)) ||
          (message.intent === "notice" && message.body.kind !== "work_context_refresh"),
      );
    let drain: Awaited<ReturnType<typeof drainInbox>>;
    let prepared: Awaited<ReturnType<DeliveryBoundary["prepareNextContext"]>>;
    let preparationFailure: unknown;
    let preparedCurrent: TCurrent | undefined;
    try {
      preparedCurrent = await input.prepareCurrent?.();
      drain = await drainInbox({
        ...input,
        persistence: deps,
        notices: selection.notices,
        threadId,
        batch: orderedBatch,
        workContext: work.workContext,
      });
      prepared = await input.prepareNextContext(drain, preparedCurrent, {
        ...selection,
        continueTask: input.continueTask,
      });
      preparationFailure = prepared.successorFailure;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      preparationFailure = error;
      // Rebuild only the durable inbox turns. Reference/image/skill preparation
      // is intentionally discarded, and NoticePort rows remain queued.
      drain = await drainInbox({
        persistence: deps,
        notices: [],
        threadId,
        batch: orderedBatch,
        workContext: work.workContext,
        knownTurnIds: input.knownTurnIds,
        expectedLeafTurnId: expectedLeaf,
      });
      prepared = { events: [], turns: [], blocks: [], requiresSplit: false };
    }
    return {
      batch: orderedBatch,
      selection,
      preparedCurrent,
      work,
      committedWorkIds,
      expectedLeaf,
      expectedLeafPosition: expectedLeafTurn?.position ?? null,
      drain,
      prepared,
      split:
        input.current.kind === "placeholder" ||
        prepared.compaction?.kind === "compact" ||
        !!preparationFailure ||
        split ||
        drain.events.length > 0 ||
        prepared.requiresSplit,
      ...(preparationFailure === undefined ? {} : { preparationFailure }),
    };
  }

  async function commitAdoption<TCurrent>(
    input: DeliveryBoundary<TCurrent>,
    adoption: PreparedAdoption<TCurrent>,
  ): Promise<AdoptedBatch<TCurrent>> {
    const { lease, currentTurn } = input;
    const threadId = lease.threadId;
    const {
      work,
      committedWorkIds,
      expectedLeaf,
      expectedLeafPosition,
      drain,
      prepared,
      split,
      batch,
      preparationFailure,
    } = adoption;
    const turns = [...drain.turns, ...prepared.turns];
    const blocks = [...drain.blocks, ...prepared.blocks];
    const events = [...drain.events, ...prepared.events];
    let next = currentTurn;
    let completed: typeof currentTurn | undefined;
    const compaction = prepared.compaction?.kind === "compact" ? prepared.compaction : undefined;

    const receipt = await leaseStore.lockReceipt(lease);
    drain.ackIds = [...new Set([...(receipt?.ids ?? []), ...drain.ackIds])].filter(
      (id) => !work.ids.includes(id) && !committedWorkIds.includes(id),
    );
    let terminal = false;
    if (split) {
      completed =
        input.current.kind === "placeholder"
          ? await input.current.complete(
              adoption.preparedCurrent,
              prepared.successorFailure === undefined ? preparationFailure : undefined,
            )
          : {
              ...currentTurn,
              status: "complete" as const,
              finishReason: "end_turn" as const,
              completedAt: new Date().toISOString(),
            };
      terminal =
        input.current.kind === "placeholder" &&
        !input.continueTask &&
        !compaction &&
        !adoption.selection.outstanding.length;
      if (terminal) {
        await persistAndAppendTurnStartEvents(deps, threadId, expectedLeaf, async () => ({
          result: undefined,
          events: [
            ...(input.current.kind === "assistant"
              ? [{ type: "turn.completed" as const, turn: completed ?? currentTurn }]
              : []),
            ...events,
          ],
        }));
        await inbox.ack(threadId, drain.ackIds);
        drain.ackIds = [];
        await deps.runClaim.release(lease);
        next = completed;
      } else {
        const leaf = turns.at(-1)?.id ?? expectedLeaf ?? currentTurn.id;
        next = reservationTurn(
          {
            ...(input.preferredSuccessorTurnId && !compaction
              ? { id: input.preferredSuccessorTurnId }
              : {}),
            threadId,
            position: nextTurnPosition(
              turns.at(-1) ??
                (expectedLeafPosition === null ? null : { position: expectedLeafPosition }),
            ),
            prevTurnId: leaf,
            writeMode: currentTurn.writeMode,
          },
          compaction,
        );
        const completedTurn = completed;

        await persistAndAppendTurnStartEvents(
          deps,
          threadId,
          expectedLeaf,
          async () => ({
            result: undefined,
            events: [
              ...(input.current.kind === "assistant"
                ? [{ type: "turn.completed" as const, turn: completedTurn }]
                : []),
              ...events,
              { type: "turn.created" as const, turn: next },
            ],
          }),
          {
            afterEvents: async () => {
              await leaseStore.bindTurn(lease, next.id, drain.ackIds, currentTurnKind(next));
              if (adoption.selection.outstanding.length > 0) await input.admit?.(next);
            },
          },
        );
      }
      if (input.current.kind === "assistant") await deps.repos.threads.updateCost(threadId, "0", 1);
    } else if (events.length > 0) {
      await persistAndAppendEvents(deps, threadId, async () => ({ result: undefined, events }));
    }

    await inbox.ack(threadId, work.ids);
    if (
      !split &&
      batch.length > 0 &&
      !(await leaseStore.setAdoptedMessageIds(lease, drain.ackIds))
    ) {
      throw new Error("Cannot adopt inbox batch after losing live run lease");
    }
    if (input.current.kind === "placeholder" && !terminal && preparationFailure !== undefined) {
      const error = writerFacingPreparationError(
        preparationFailure instanceof Error
          ? preparationFailure
          : new Error(String(preparationFailure)),
      );
      const completion = await finalizeExecution(deps, {
        threadId,
        turnId: next.id,
        cause: {
          kind: "failed",
          reason: error.code,
          error,
          copy: error.message,
        },
      });
      next = completion.turn;
      await inbox.ack(threadId, drain.ackIds);
    }
    if (batch.length > 0 || input.current.kind === "placeholder" || compaction)
      await appendPending(threadId);
    drain.turns = turns;
    drain.blocks = blocks;
    return {
      drain,
      preparedCurrent: adoption.preparedCurrent,
      context: prepared.context,
      next,
      split,
      terminal,
      completed,
      compaction,
      ...(preparationFailure === undefined ? {} : { preparationFailure }),
    };
  }

  async function adopt<TCurrent>(
    input: DeliveryBoundary<TCurrent>,
  ): Promise<AdoptedBatch<TCurrent>> {
    return prepareAndCommit({
      threadId: input.lease.threadId,
      select: () => selectForPreparation(input.lease.threadId, "boundary"),
      signal: input.signal,
      validate: async () => {
        if ((await leaseStore.lockReceipt(input.lease))?.cancelRequested)
          throw new DOMException("The operation was aborted", "AbortError");
      },
      prepare: (selection, work) => prepareAdoption(input, selection, work),
      hasPreparationFailure: (prepared) => prepared.preparationFailure !== undefined,
      commit: async (_selection, _work, prepared) => commitAdoption(input, prepared),
    });
  }

  return {
    ...createThreadControls({
      withThreadLock: threadLock.withThreadLock,
      findMessage: inbox.findMessage,
      enqueue,
      findControlTurn: (id, controlId) => deps.repos.turns.findByControlId(id, controlId),
      pending: (id) => readPendingInbox(inbox, id),
      acknowledge: async (id, controlId) => {
        await inbox.ack(id, [controlId]);
        await appendPending(id);
      },
      effectiveTurns: async (id) => {
        const thread = await deps.repos.threads.findByIdIncludingDeleted(id);
        if (!thread) return [];
        return (await loadThreadConversationContext(deps.repos, thread)).turns;
      },
    }),
    threadChanged,
    async projectChanged(projectId) {
      const mutationId = crypto.randomUUID();
      for (const threadId of await inbox.workNoticeTargets(projectId))
        await threadChanged(threadId, mutationId);
    },
    materializeIdle,
    async sweepWorkNotices() {
      let threads = await inbox.pendingWorkThreads(100, workCursor);
      if (threads.length === 0 && workCursor) threads = await inbox.pendingWorkThreads(100);
      workCursor = threads.at(-1);
      // Finish the bounded page even when one target is poisoned.
      const results = await Promise.allSettled(threads.map(materializeIdle));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      return threads.length;
    },
    refreshPending: (threadId) =>
      threadLock.withThreadLock(threadId, () => appendPending(threadId)),
    retireOrphanedReply: (threadId, turnId) =>
      threadLock.withThreadLock(threadId, () => retireOrphanedReply(threadId, turnId)),
    clearOrphanedTurn: (threadId, turnId) =>
      threadLock.withThreadLock(threadId, () => clearOrphanedTurnForRepair(threadId, turnId)),
    repairOrphanedTurns: async (lease) => {
      const reports = await threadLock.withThreadLock(lease.threadId, () =>
        finalizeOrphanedTurns(
          {
            ...deps,
            publishStatus: deps.publishStatus,
            retireOrphanedReply,
            clearOrphanedTurn: clearOrphanedTurnForRepair,
          },
          { threadId: lease.threadId },
        ),
      );
      await deps.publishFinalizedReports(reports);
    },
    selectPending: inbox.selectPending,
    readPendingProjection: inbox.readPendingProjection,
    pendingMessageThreads: async (limit, afterThreadId) => {
      return inbox.pendingMessageThreads(limit, afterThreadId);
    },
    enqueue: (draft) => threadLock.withThreadLock(draft.threadId, () => enqueue(draft)),
    withThreadLock: (threadId, operation) =>
      threadLock.withThreadLock(threadId, () =>
        operation({
          materializePrefix: () => materializePrefix(threadId),
          async acknowledge(ids) {
            await inbox.ack(threadId, [...ids]);
            await appendPending(threadId);
          },
          enqueue(draft) {
            if (draft.threadId !== threadId)
              throw new Error("Scoped delivery cannot enqueue another thread");
            return enqueue(draft);
          },
        }),
      ),
    adoptBatch: async (lease, prepare, options) => {
      const result = await prepareAndCommit({
        threadId: lease.threadId,
        select: (failedControlIds) =>
          selectForPreparation(lease.threadId, "run_start", failedControlIds),
        retryControlId: (selection) =>
          selection.next.kind === "control" ? selection.next.control.id : null,
        signal: options?.signal,
        validate: async () => {
          if ((await leaseStore.lockReceipt(lease))?.cancelRequested)
            throw new DOMException("The operation was aborted", "AbortError");
        },
        prepare: (selection) => prepare(selection),
        hasPreparationFailure: (prepared) => !prepared || prepared.preparationFailure !== undefined,
        commit: async (_selection, work, prepared) => {
          if (!prepared) return null;
          await prepared.persist?.();
          await inbox.ack(lease.threadId, work.ids);
          await inbox.ack(lease.threadId, prepared.completedControlIds ?? []);
          await leaseStore.bindTurn(
            lease,
            prepared.turnId,
            prepared.messageIds.filter(
              (id) => !work.ids.includes(id) && !prepared.completedControlIds?.includes(id),
            ),
            prepared.turnKind,
          );
          await appendPending(lease.threadId);
          return { value: prepared.value };
        },
      });
      if (!result) throw new NoPendingWakeError(lease.threadId);
      return result.value;
    },
    ackWithResponse: (lease, ids, persist) =>
      threadLock.withThreadLock(lease.threadId, async () => {
        const result = await persist();
        if (ids.length > 0) {
          if (!(await leaseStore.clearReceipt(lease, ids)))
            throw new Error("Cannot ack after losing live run lease");
          await inbox.ack(lease.threadId, ids);
          await appendPending(lease.threadId);
        }
        return result;
      }),
    splitAndContinue: (input) => adopt(input),
    close: async (input) => {
      const threadId = input.lease.threadId;
      const disposition = await threadLock.withThreadLock(threadId, async () => {
        // Serialize the terminal decision with remote cancellation, not only the loop's cached flag.
        const receipt = await leaseStore.lockReceipt(input.lease);
        const cause = receipt?.cancelRequested
          ? { kind: "cancelled" as const, reason: "cancelled" }
          : input.cause;
        const finalCause = cause;
        if (input.continueWith && cause.kind === "success") {
          const { selection } = await selectForPreparation(threadId, "boundary");
          if (
            selection.batch.some((message) => message.intent === "message") ||
            selection.workContext
          ) {
            return { kind: "prepare_split" as const };
          }
        }
        await input.settleSummaryResponses?.();
        const completion = await finalizeExecution(deps, {
          threadId,
          turnId: input.turnId,
          cause: finalCause,
        });
        if (
          completion.turn.role === "assistant" &&
          (completion.turn.status === "cancelled" || completion.turn.status === "error")
        ) {
          await inbox.ack(threadId, receipt?.ids ?? []);
        }
        await deps.runClaim.release(input.lease);
        await appendPending(threadId);
        return { kind: "completed" as const, completion };
      });
      if (disposition.kind === "completed") return disposition;

      const boundary = input.continueWith as DeliveryBoundary;
      const adopted = await adopt(boundary);
      if (adopted.split) return { kind: "split", adopted };
      const completion = await threadLock.withThreadLock(threadId, async () => {
        const receipt = await leaseStore.lockReceipt(input.lease);
        const cause = receipt?.cancelRequested
          ? { kind: "cancelled" as const, reason: "cancelled" }
          : input.cause;
        const finalCause = cause;
        const result = await finalizeExecution(deps, {
          threadId,
          turnId: input.turnId,
          cause: finalCause,
        });
        if (
          result.turn.role === "assistant" &&
          (result.turn.status === "cancelled" || result.turn.status === "error")
        )
          await inbox.ack(threadId, receipt?.ids ?? []);
        await deps.runClaim.release(input.lease);
        await appendPending(threadId);
        return result;
      });
      return { kind: "completed", completion };
    },
  };
}

function sameInboxBatch(left: readonly InboxMessage[], right: readonly InboxMessage[]): boolean {
  return (
    left.length === right.length && left.every((message, index) => message.id === right[index]?.id)
  );
}
