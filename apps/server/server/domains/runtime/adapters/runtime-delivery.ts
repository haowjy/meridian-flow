/** Shared delivery transitions. Concrete adapters supply one compatible transaction/store bundle. */
import type { ProjectId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { isPendingPlaceholder } from "@meridian/contracts/threads";
import type { NoticePort } from "../../notices/index.js";
import { SystemUpdateMetadataCodec } from "../../threads/index.js";
import { nextTurnPosition } from "../../threads/order-turns.js";
import { persistPreparedControlEvents } from "../loop/compaction-undo.js";
import {
  absorbPendingCompact,
  type ControlMessage,
  planControlBarrier,
} from "../loop/control-barrier.js";
import { finalizeExecution } from "../loop/execution-finalizer.js";
import { reserveHandoffSeed } from "../loop/handoff-seed.js";
import { drainInbox, planMessageTurns } from "../loop/inbox-context.js";
import { currentTurnKind, reservationTurn } from "../loop/local-turn.js";
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
import { UndoRequestPreparationError } from "../loop/request-preparation.js";
import { NoPendingWakeError } from "../loop/run-turn-port.js";
import type {
  AdoptedBatch,
  DeliveryBoundary,
  DeliverySelection,
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
  lockThreadReceipt(
    threadId: ThreadId,
    liveOnly: boolean,
  ): Promise<{ ids: string[]; turnId: TurnId | null } | null>;
  bindTurn(
    lease: Lease,
    turnId: TurnId,
    ids: readonly string[],
    kind: "assistant" | "compaction" | "handoff_brief",
  ): Promise<void>;
  setAdoptedMessageIds(lease: Lease, ids: readonly string[]): Promise<boolean>;
  clearReceipt(lease: Lease, expectedIds: readonly string[]): Promise<boolean>;
  lockReceipt(lease: Lease): Promise<{ ids: string[]; cancelRequested: boolean } | null>;
}

const PREPARATION_ATTEMPTS = 3;

export function createDeliveryAdapter(
  deps: PersistenceDeps & {
    repos: import("../../threads/index.js").ThreadRepositories;
    inbox: DeliveryStore;
    leaseStore: DeliveryLeaseStore;
    runClaim: Pick<RunClaim, "release" | "withExclusiveThread" | "cancelExecution">;
    publishFinalizedReports(reports: readonly SavedExecutionReport[]): Promise<void>;
    workContext: import("../loop/work-context.js").WorkContextReader;
    threadLock: ThreadLock;
    notices: NoticePort;
    runStarter: RunStarter;
    schedulePostCommit(task: () => Promise<void>): void;
  },
): RuntimeDelivery {
  const { inbox, leaseStore, threadLock } = deps;
  const appendPending = async (threadId: ThreadId) => {
    await deps.eventWriter.appendEvent(threadId, {
      type: "inbox.changed",
      threadId,
      pending: await readPendingInbox(inbox, threadId),
    });
  };
  async function findStaleSeedControls(pending: InboxMessage[]) {
    const stale: string[] = [];
    for (const row of pending) {
      if (row.body.kind !== "handoff_brief" || !row.body.seedTurnId) continue;
      const seed = await deps.repos.turns.findById(row.body.seedTurnId);
      if (!seed || !isPendingPlaceholder(seed)) stale.push(row.id);
    }
    return stale;
  }
  async function selectForPreparation(
    threadId: ThreadId,
    satisfyPendingCompact?: boolean,
    expandUndos = true,
  ) {
    const pendingBatch = await inbox.selectPending(threadId);
    const staleSeedControls = await findStaleSeedControls(pendingBatch);
    const eligible = pendingBatch.filter((row) => !staleSeedControls.includes(row.id));
    const projection = await inbox.readPendingProjection(threadId);
    const headControl = eligible.find(
      (row) => row.intent === "control" && !projection.run?.messageIds.includes(row.id),
    );
    const satisfiesControlId =
      satisfyPendingCompact && headControl?.body.kind === "compact" ? headControl.id : undefined;
    const boundIds = new Set([
      ...(projection.run?.messageIds ?? []),
      ...(satisfiesControlId ? [satisfiesControlId] : []),
    ]);
    const chained = await Promise.all(
      eligible
        .filter((row) => !boundIds.has(row.id))
        .map((row) => deps.repos.turns.findById(row.id)),
    );
    const barrier = planControlBarrier({
      pending: eligible,
      boundIds,
      chainedIds: new Set(chained.flatMap((turn) => (turn ? [turn.id] : []))),
    });
    const controls: ControlMessage[] = [];
    const work = await workBatch(threadId, barrier.batch);
    const followingBatches: NonNullable<DeliverySelection["followingBatches"]> = [];
    let nextBarrier = barrier;
    const selectedIds = new Set(boundIds);
    while (nextBarrier.execute) {
      controls.push(nextBarrier.execute);
      if (!expandUndos || nextBarrier.execute.body.kind !== "compaction_undo") break;
      const afterControlId = nextBarrier.execute.id;
      selectedIds.add(afterControlId);
      for (const row of nextBarrier.batch) selectedIds.add(row.id);
      nextBarrier = planControlBarrier({
        pending: eligible,
        boundIds: selectedIds,
        chainedIds: new Set(chained.flatMap((turn) => (turn ? [turn.id] : []))),
      });
      const following = await workBatch(threadId, nextBarrier.batch);
      followingBatches.push({
        afterControlId,
        batch: following.batch,
        ackIds: [...new Set([...following.ids, ...following.batch.map((row) => row.id)])],
        workContext: following.workContext,
      });
    }
    const adoptedIds = new Set(
      [...barrier.batch, ...followingBatches.flatMap((s) => s.batch)].map((row) => row.id),
    );
    const [notices, thread] = await Promise.all([
      deps.notices.peek(threadId),
      deps.repos.threads.findById(threadId),
    ]);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const selection: DeliverySelection = {
      batch: work.batch,
      control: barrier.execute,
      controls,
      followingBatches,
      satisfiesControlId,
      headControl:
        (eligible.find(
          (row) =>
            row.intent === "control" &&
            !boundIds.has(row.id) &&
            !controls.some((c) => c.id === row.id && c.body.kind === "compaction_undo"),
        ) as ControlMessage | undefined) ?? null,
      outstanding: eligible.filter(
        (row) => row.intent === "message" && (boundIds.has(row.id) || adoptedIds.has(row.id)),
      ),
      workContext: work.workContext,
      notices,
      activeLeafTurnId: thread.activeLeafTurnId,
    };
    return { selection, pendingBatch, work, staleSeedControls };
  }
  async function selectionStillCurrent(
    threadId: ThreadId,
    selected: Awaited<ReturnType<typeof selectForPreparation>>,
  ) {
    const [pendingBatch, thread] = await Promise.all([
      inbox.selectPending(threadId),
      deps.repos.threads.findById(threadId),
    ]);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return (
      thread.activeLeafTurnId === selected.selection.activeLeafTurnId &&
      sameInboxBatch(pendingBatch, selected.pendingBatch) &&
      (await findStaleSeedControls(pendingBatch)).join() === selected.staleSeedControls.join()
    );
  }
  async function prepareAndCommit<TPrepared, TResult>(input: {
    threadId: ThreadId;
    signal?: AbortSignal;
    satisfyPendingCompact?: boolean;
    validate?: () => Promise<void>;
    prepare: (
      selection: DeliverySelection,
      work: Awaited<ReturnType<typeof workBatch>>,
    ) => Promise<TPrepared>;
    hasPreparationFailure: (prepared: TPrepared) => boolean;
    commit: (
      selection: DeliverySelection,
      work: Awaited<ReturnType<typeof workBatch>>,
      prepared: TPrepared,
      retiredSeedControls: readonly string[],
    ) => Promise<TResult>;
  }): Promise<TResult> {
    let committingUndoIds: string[] = [];
    let failedUndoIds: ReadonlySet<string> = new Set();
    try {
      return await attemptPreparation();
    } catch (error) {
      if (input.signal?.aborted || committingUndoIds.length === 0) throw error;
      // The first transaction rolled back. Retire only its undo controls in a fresh
      // preparation/commit, preserving messages and the ordinary continuation.
      failedUndoIds = new Set(committingUndoIds);
      return attemptPreparation();
    }
    async function attemptPreparation(): Promise<TResult> {
      for (let attempt = 0; attempt < PREPARATION_ATTEMPTS; attempt += 1) {
        const lockedPreparation = attempt === PREPARATION_ATTEMPTS - 1;
        if (lockedPreparation) {
          return threadLock.withThreadLock(input.threadId, async () => {
            const selected = await selectForPreparation(
              input.threadId,
              input.satisfyPendingCompact,
            );
            selected.selection.failedUndoIds = failedUndoIds;
            input.signal?.throwIfAborted();
            const prepared = await input.prepare(selected.selection, selected.work);
            input.signal?.throwIfAborted();
            await input.validate?.();
            return commitSelected(selected, prepared);
          });
        }

        const selected = await selectForPreparation(input.threadId, input.satisfyPendingCompact);
        selected.selection.failedUndoIds = failedUndoIds;
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
      selected: Awaited<ReturnType<typeof selectForPreparation>>,
      prepared: TPrepared,
    ): Promise<TResult> {
      committingUndoIds = (selected.selection.controls ?? [])
        .filter((c) => c.body.kind === "compaction_undo")
        .map((c) => c.id);
      // Retire invalid seed barriers in the same transaction as their replacement reservation.
      await inbox.ack(input.threadId, selected.staleSeedControls);
      const result = await input.commit(
        selected.selection,
        selected.work,
        prepared,
        selected.staleSeedControls,
      );
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
      deps.schedulePostCommit(() => deps.runStarter.start(draft.threadId));
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
    const { selection, work } = await selectForPreparation(threadId, false, false);
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
        const reports = await finalizeOrphanedTurns(deps, { threadId });
        deps.schedulePostCommit(() => deps.publishFinalizedReports(reports));
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
    selection: DeliverySelection;
    deferred?: boolean;
  };

  async function prepareAdoption<TCurrent>(
    input: DeliveryBoundary<TCurrent>,
    selection: DeliverySelection,
    work: Awaited<ReturnType<typeof workBatch>>,
  ): Promise<PreparedAdoption<TCurrent>> {
    const { lease } = input;
    if (input.deferControl && selection.control)
      return {
        batch: [],
        work: { ids: [], batch: [], workContext: undefined },
        committedWorkIds: [],
        expectedLeaf: selection.activeLeafTurnId,
        expectedLeafPosition: null,
        drain: { turns: [], blocks: [], events: [], ackIds: [] },
        prepared: { events: [], turns: [], blocks: [], requiresSplit: false },
        split: false,
        selection,
        deferred: true,
      };
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
      if (prepared.compaction)
        prepared.compaction = absorbPendingCompact(prepared.compaction, selection.headControl);
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
      prepared =
        error instanceof UndoRequestPreparationError
          ? { ...error.after(drain.turns.at(-1) ?? expectedLeafTurn), requiresSplit: true }
          : { events: [], turns: [], blocks: [], requiresSplit: false };
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
        selection.controls?.some((control) => control.body.kind === "handoff_brief") ||
        prepared.compaction?.kind === "compact" ||
        !!prepared.undos?.length ||
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
    drain.ackIds = [
      ...new Set([...(receipt?.ids ?? []), ...drain.ackIds, ...(prepared.adoptedIds ?? [])]),
    ].filter((id) => !work.ids.includes(id) && !committedWorkIds.includes(id));
    let terminal = false;
    if (split) {
      completed =
        input.current.kind === "placeholder"
          ? await input.current.complete(
              adoption.preparedCurrent,
              preparationFailure,
              adoption.selection,
            )
          : {
              ...currentTurn,
              status: "complete" as const,
              finishReason: "end_turn" as const,
              completedAt: new Date().toISOString(),
            };
      const pending = await inbox.selectPending(threadId);
      const endingControls =
        input.current.kind === "placeholder"
          ? pending
              .filter(
                (row) =>
                  row.intent === "control" &&
                  (receipt?.ids.includes(row.id) ||
                    row.id === adoption.selection.satisfiesControlId),
              )
              .map((row) => row.id)
          : [];
      const undoIds = (prepared.undos ?? []).map((u) => u.controlId);
      endingControls.push(...undoIds);
      await inbox.ack(threadId, endingControls);
      drain.ackIds = drain.ackIds.filter((id) => !endingControls.includes(id));
      const briefControl = adoption.selection.controls?.find(
        (control) => control.body.kind === "handoff_brief",
      );
      const nextControlId =
        briefControl?.id ?? compaction?.controlMessageId ?? compaction?.satisfiesControlId;
      if (nextControlId) drain.ackIds.push(nextControlId);
      terminal =
        (input.current.kind === "placeholder" || !!prepared.undos?.length) &&
        !input.continueTask &&
        !compaction &&
        !briefControl &&
        !adoption.selection.outstanding.length;
      if (terminal) {
        await persistAndAppendTurnStartEvents(deps, threadId, expectedLeaf, async () => ({
          result: undefined,
          events: await persistPreparedControlEvents(
            deps,
            threadId,
            [
              ...(input.current.kind === "assistant"
                ? [{ type: "turn.completed" as const, turn: completed! }]
                : []),
              ...events,
            ],
            prepared.undos ?? [],
          ),
        }));
        await inbox.ack(threadId, drain.ackIds);
        drain.ackIds = [];
        await deps.runClaim.release(lease);
        next = prepared.undos?.at(-1)?.turn ?? completed;
      } else {
        const leaf = turns.at(-1)?.id ?? expectedLeaf ?? currentTurn.id;
        next = reservationTurn(
          {
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
        if (briefControl) {
          const thread = await deps.repos.threads.findById(threadId);
          if (!thread) throw new Error("Handoff thread is missing");
          next = await reserveHandoffSeed(deps.repos, next, briefControl, thread);
        }
        const completedTurn = completed;

        await persistAndAppendTurnStartEvents(
          deps,
          threadId,
          expectedLeaf,
          async () => ({
            result: undefined,
            events: await persistPreparedControlEvents(
              deps,
              threadId,
              [
                ...(input.current.kind === "assistant"
                  ? [{ type: "turn.completed" as const, turn: completedTurn }]
                  : []),
                ...events,
                { type: "turn.created", turn: next },
              ],
              prepared.undos ?? [],
            ),
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
        cause: { kind: "failed", reason: error.code, error, acknowledgeInbox: true },
      });
      next = completion.turn;
      await inbox.ack(threadId, drain.ackIds);
    }
    if (
      batch.length > 0 ||
      input.current.kind === "placeholder" ||
      compaction ||
      prepared.undos?.length
    )
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
      signal: input.signal,
      satisfyPendingCompact: input.satisfyPendingCompact,
      validate: async () => {
        if ((await leaseStore.lockReceipt(input.lease))?.cancelRequested)
          throw new DOMException("The operation was aborted", "AbortError");
      },
      prepare: (selection, work) => prepareAdoption(input, selection, work),
      hasPreparationFailure: (prepared) =>
        prepared.deferred === true || prepared.preparationFailure !== undefined,
      commit: async (_selection, _work, prepared) => commitAdoption(input, prepared),
    });
  }

  return {
    async enqueueSeedBrief({ threadId, seedTurnId, controlId }) {
      await threadLock.withThreadLock(threadId, () =>
        enqueue({
          id: controlId,
          threadId,
          intent: "control",
          body: { kind: "handoff_brief", seedTurnId },
          provenance: { kind: "system", source: "handoff" },
          idempotencyKey: seedTurnId,
        }),
      );
    },
    ...createThreadControls({
      withThreadLock: threadLock.withThreadLock,
      findMessage: inbox.findMessage,
      findThread: (id) => deps.repos.threads.findById(id),
      pendingRows: inbox.selectPending,
      cancelSeed: async (threadId, turnId) => {
        await finalizeExecution(deps, {
          threadId,
          turnId,
          cause: { kind: "cancelled", reason: "cancelled" },
        });
      },
      enqueue,
      findTurn: (id) => deps.repos.turns.findById(id),
      findControlTurn: (id, controlId) => deps.repos.turns.findByControlId(id, controlId),
      findLatestHandoffSeed: (id) => deps.repos.turns.findLatestHandoffSeed(id),
      pending: (id) => readPendingInbox(inbox, id),
      lockReceipt: leaseStore.lockThreadReceipt,
      cancel: leaseStore.cancelThreadReceipt,
      acknowledge: async (id, controlId) => {
        await inbox.ack(id, [controlId]);
        await appendPending(id);
      },
      wake: (id) => deps.schedulePostCommit(() => deps.runStarter.start(id)),
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
    repairOrphanedTurns: async (lease) => {
      const reports = await threadLock.withThreadLock(lease.threadId, () =>
        finalizeOrphanedTurns(deps, { threadId: lease.threadId }),
      );
      await deps.publishFinalizedReports(reports);
    },
    selectPending: inbox.selectPending,
    readPendingProjection: inbox.readPendingProjection,
    pendingMessageThreads: inbox.pendingMessageThreads,
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
        signal: options?.signal,
        validate: async () => {
          if ((await leaseStore.lockReceipt(lease))?.cancelRequested)
            throw new DOMException("The operation was aborted", "AbortError");
        },
        prepare: (selection) => prepare(selection),
        hasPreparationFailure: (prepared) => !prepared || prepared.preparationFailure !== undefined,
        commit: async (_selection, work, prepared, retiredSeedControls) => {
          if (!prepared) {
            if (retiredSeedControls.length > 0) await appendPending(lease.threadId);
            return null;
          }
          await prepared.persist?.();
          await inbox.ack(lease.threadId, work.ids);
          await inbox.ack(lease.threadId, prepared.completedControlIds ?? []);
          if (prepared.terminal) {
            await inbox.ack(lease.threadId, [...prepared.messageIds]);
            await deps.runClaim.release(lease);
          } else
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
        if (input.continueWith && cause.kind === "success") {
          const { selection } = await selectForPreparation(threadId);
          if (
            !selection.control &&
            (selection.batch.some((message) => message.intent === "message") ||
              selection.workContext)
          ) {
            return { kind: "prepare_split" as const };
          }
        }
        await input.settleSummaryResponses?.();
        const completion = await finalizeExecution(deps, {
          threadId,
          turnId: input.turnId,
          cause,
        });
        if (
          completion.turn.status === "cancelled" ||
          (cause.kind === "failed" &&
            (cause.acknowledgeInbox ||
              completion.turn.role === "system" ||
              (completion.turn.metadata as import("@meridian/contracts/threads").JsonObject | null)
                ?.trigger === "manual"))
        ) {
          const ids =
            completion.turn.role === "system" ||
            (completion.turn.metadata as import("@meridian/contracts/threads").JsonObject | null)
              ?.trigger === "manual"
              ? (await inbox.selectPending(threadId))
                  .filter((row) => row.intent === "control" && receipt?.ids.includes(row.id))
                  .map((row) => row.id)
              : (receipt?.ids ?? []);
          await inbox.ack(threadId, ids);
        }
        await deps.runClaim.release(input.lease);
        await appendPending(threadId);
        return { kind: "completed" as const, completion };
      });
      if (disposition.kind === "completed") return disposition;

      const boundary = input.continueWith as DeliveryBoundary;
      const adopted = await adopt({ ...boundary, deferControl: true });
      if (adopted.split) return { kind: "split", adopted };
      const completion = await threadLock.withThreadLock(threadId, async () => {
        const receipt = await leaseStore.lockReceipt(input.lease);
        const cause = receipt?.cancelRequested
          ? { kind: "cancelled" as const, reason: "cancelled" }
          : input.cause;
        const result = await finalizeExecution(deps, {
          threadId,
          turnId: input.turnId,
          cause,
        });
        if (result.turn.status === "cancelled") await inbox.ack(threadId, receipt?.ids ?? []);
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
