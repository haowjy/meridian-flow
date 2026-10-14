/** Shared delivery transitions. Concrete adapters supply one compatible transaction/store bundle. */
import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { isPendingPlaceholder, isTerminalTurnStatus, type Turn } from "@meridian/contracts/threads";
import type { NoticePort } from "../../notices/index.js";
import { SystemUpdateMetadataCodec } from "../../threads/index.js";
import { nextTurnPosition } from "../../threads/order-turns.js";
import type { DetachedWorkTracker } from "../detached-work.js";
import { finalizeExecution } from "../loop/execution-finalizer.js";
import { drainInbox, planMessageTurns } from "../loop/inbox-context.js";
import { currentTurnKind, reservationTurn } from "../loop/local-turn.js";
import { type InboxWorkSelection, next } from "../loop/next-inbox-work.js";
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
import { preparationFailureError } from "../loop/preparation-failure.js";
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
import { type WriteModeSwitchPort, writeModeSwitchTurn } from "../loop/write-mode-switch.js";

/** Adapter-private storage primitives; never injected into the model loop or producers. */
export interface DeliveryStore extends InboxReader {
  setBlockedReason(threadId: ThreadId, reason: "credits_exhausted" | null): Promise<void>;
  findMessage(id: string): Promise<InboxMessage | null>;
  workNoticeTargets(workId: WorkId): Promise<ThreadId[]>;
  canMaterializeWork(threadId: ThreadId): Promise<boolean>;
  pendingWorkThreads(limit: number, afterThreadId?: ThreadId): Promise<ThreadId[]>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  /**
   * Marks rows delivered once (rows already delivered are untouched). A message
   * row records `byTurnId` as its deliverer. Returns the message rows this call
   * delivered, in `seq` order.
   */
  ack(threadId: ThreadId, ids: string[], byTurnId?: TurnId | null): Promise<string[]>;
}

export interface DeliveryLeaseStore {
  cancelThreadReceipt(threadId: ThreadId, turnId: TurnId): Promise<boolean>;
  lockThreadReceipt(
    threadId: ThreadId,
  ): Promise<{ ids: string[]; turnId: TurnId | null; lease: Lease } | null>;
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
  /**
   * The thread's lease row regardless of holder and expiry, locked. Called only
   * under a newly acquired claim, which proves its holder is gone.
   */
  lockStaleExecution(threadId: ThreadId): Promise<{ executionId: string } | null>;
  deleteStaleExecution(threadId: ThreadId, executionId: string): Promise<boolean>;
}

const PREPARATION_ATTEMPTS = 3;

export function createDeliveryAdapter(
  deps: PersistenceDeps & {
    backgroundTasks: DetachedWorkTracker;
    repos: import("../../threads/index.js").ThreadRepositories;
    toolRegistry?: Pick<import("../tools/types.js").ToolRegistry, "getRegistration">;
    inbox: DeliveryStore;
    leaseStore: DeliveryLeaseStore;
    runClaim: Pick<
      RunClaim,
      "release" | "abandon" | "withExclusiveThread" | "cancelExecution" | "holder"
    >;
    publishFinalizedReports(reports: readonly SavedExecutionReport[]): Promise<void>;
    workContext: import("../loop/work-context.js").WorkContextReader;
    threadLock: ThreadLock;
    notices: NoticePort;
    runStarter: RunStarter;
    schedulePostCommit(task: () => Promise<void>): void;
    publishStatus?(threadId: ThreadId): Promise<void>;
    /** The thread's journal head as the socket numbers its frames. */
    headSeq(threadId: ThreadId): Promise<bigint>;
    writeModeSwitch: WriteModeSwitchPort;
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
  /** The turn current when an execution acknowledges messages, and its execution. */
  type Deliverer = { turn: { id: string; position: number | null }; executionId: string | null };
  const deliveredBy = (lease: Lease, turn: Pick<Turn, "id" | "position">): Deliverer => ({
    turn,
    executionId: lease.executionId,
  });
  /**
   * The one acknowledgement path. Message rows this call actually delivers
   * record their deliverer and are journaled once as `messages.delivered`, in
   * the transaction that delivers them. Controls and notices record nothing.
   * Every retirement path goes through here under the caller's thread lock, so
   * a usage block is cleared the moment no message or control waits behind it.
   */
  const ack = async (threadId: ThreadId, ids: readonly string[], by: Deliverer | null = null) => {
    const delivered =
      ids.length === 0 ? [] : await inbox.ack(threadId, [...ids], (by?.turn.id as TurnId) ?? null);
    if (delivered.length > 0)
      await deps.eventWriter.appendEvent(threadId, {
        type: "messages.delivered",
        byTurnId: by?.turn.id ?? null,
        byTurnPosition: by?.turn.position ?? null,
        executionId: by?.executionId ?? null,
        userTurnIds: delivered,
      });
    const projection = await inbox.readPendingProjection(threadId);
    if (
      !projection.messages.some(
        (message) => message.intent === "message" || message.intent === "control",
      )
    )
      await inbox.setBlockedReason(threadId, null);
  };
  const executionEnded = (threadId: ThreadId, executionId: string) =>
    deps.eventWriter.appendEvent(threadId, { type: "execution.ended", executionId });
  /**
   * Ends an execution in the transaction that wrote its last terminal turn:
   * deletes the lease row and journals `execution.ended` when some turn carries
   * the execution (an execution that reserved nothing is never observable).
   */
  async function endExecution(lease: Lease) {
    if (!(await deps.runClaim.release(lease))) return;
    if ((await deps.repos.turns.listByExecution(lease.threadId, lease.executionId)).length > 0)
      await executionEnded(lease.threadId, lease.executionId);
  }
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
    const orphan = await deps.repos.turns.findById(turnId);
    await ack(threadId, ids, {
      turn: { id: turnId, position: orphan?.position ?? null },
      executionId: orphan?.executionId ?? null,
    });
    await appendPending(threadId);
  };
  const clearOrphanedTurnForRepair = async (threadId: ThreadId, turnId: TurnId) => {
    await clearOrphanedTurn(threadId, turnId);
  };
  /**
   * The one orphan repair for every path that takes the claim. A dead reply's
   * receipt retires with its messages answered; a dead compaction's or seed's
   * receipt clears and leaves its unanswered messages pending for the next run.
   * Call under the thread lock and the session claim.
   */
  const repairOrphans = (threadId: ThreadId) =>
    finalizeOrphanedTurns(
      { ...deps, retireOrphanedReply, clearOrphanedTurn: clearOrphanedTurnForRepair },
      { threadId },
    );
  /**
   * The child-report repair for what the primary scan leaves alone (a
   * subagent's assistant), run while a stale row still holds its receipt: fail
   * the turn as the report repair does, so its report finalizes and its
   * messages retire. The claim proves every unsettled turn is an orphan,
   * including one an older lease bound without recording its execution.
   */
  async function repairStaleExecutionTurns(threadId: ThreadId) {
    const reports: SavedExecutionReport[] = [];
    for (const turn of await deps.repos.turns.listUnsettledForThread(threadId)) {
      if (isTerminalTurnStatus(turn.status)) continue;
      if (turn.role !== "assistant" && turn.role !== "compaction") continue;
      const completion = await finalizeExecution(deps, {
        threadId,
        turnId: turn.id as TurnId,
        ...(turn.role === "compaction" ? { reportContent: "empty" as const } : {}),
        cause: {
          kind: "failed",
          reason: "orphaned",
          error: "Child execution stopped before terminal completion",
        },
      });
      if (turn.role === "assistant") await retireOrphanedReply(threadId, turn.id as TurnId);
      else await clearOrphanedTurnForRepair(threadId, turn.id as TurnId);
      if (completion.report) reports.push(completion.report);
    }
    return reports;
  }
  /**
   * Call holding the session claim. With no `repair`, this is the run starter's
   * full settlement: repairs may commit separately (a crash between them loses
   * nothing, because the end is decided from turns that carry the execution's
   * id, never from the row's receipt arrays), then the stale row ends and is
   * deleted in one transaction with the end append.
   *
   * A sweep lane passes its own `repair` and settles only what it names: a
   * stale candidate may not repair a newer receipt's execution, so the row is
   * released (its end journaled when a turn carries it) only when the repair
   * retired its receipt or the receipt was already empty.
   */
  async function settleStaleExecution<T = void>(
    threadId: ThreadId,
    repair?: () => Promise<T>,
  ): Promise<T | void> {
    if (repair) return settleSweepLane(threadId, repair);
    const reports = await threadLock.withThreadLock(threadId, async () => {
      const repaired = await repairOrphans(threadId);
      const stale = await leaseStore.lockStaleExecution(threadId);
      if (stale) repaired.push(...(await repairStaleExecutionTurns(threadId)));
      return repaired;
    });
    await deps.publishFinalizedReports(reports);
    await threadLock.withThreadLock(threadId, async () => {
      const stale = await leaseStore.lockStaleExecution(threadId);
      if (!stale) return;
      const turns = await deps.repos.turns.listByExecution(threadId, stale.executionId);
      if (turns.some((turn) => !isTerminalTurnStatus(turn.status)))
        throw new Error("A stale execution still has unsettled turns after repair");
      if (turns.length > 0) await executionEnded(threadId, stale.executionId);
      await leaseStore.deleteStaleExecution(threadId, stale.executionId);
      await appendPending(threadId);
      // The row's deletion is what turns the chat idle for readers.
      schedulePostCommit(async () => {
        await deps.publishStatus?.(threadId);
      });
    });
  }
  async function settleSweepLane<T>(threadId: ThreadId, repair: () => Promise<T>): Promise<T> {
    return threadLock.withThreadLock(threadId, async () => {
      const receipt = await leaseStore.lockThreadReceipt(threadId);
      const result = await repair();
      const repaired = await leaseStore.lockThreadReceipt(threadId);
      if (
        receipt &&
        repaired?.lease.executionId === receipt.lease.executionId &&
        repaired.lease.holderId === receipt.lease.holderId &&
        repaired.turnId === null &&
        repaired.ids.length === 0
      )
        await endExecution(receipt.lease);
      await appendPending(threadId);
      schedulePostCommit(async () => {
        await deps.publishStatus?.(threadId);
      });
      return result;
    });
  }
  async function releaseExecution(lease: Lease): Promise<"released" | "ended" | "abandoned"> {
    let outcome: "released" | "ended" | "abandoned";
    try {
      outcome = await threadLock.withThreadLock(lease.threadId, async () => {
        if (!(await leaseStore.lockReceipt(lease))) {
          // A close already ended it; only the physical claim may remain.
          await deps.runClaim.release(lease);
          return "released" as const;
        }
        const turns = await deps.repos.turns.listByExecution(lease.threadId, lease.executionId);
        if (turns.some((turn) => !isTerminalTurnStatus(turn.status))) return "abandoned" as const;
        await endExecution(lease);
        await appendPending(lease.threadId);
        return "ended" as const;
      });
    } catch (error) {
      await deps.runClaim.abandon(lease);
      throw error;
    }
    if (outcome === "abandoned") await deps.runClaim.abandon(lease);
    return outcome;
  }
  type SelectedDelivery<TSelection> = {
    selection: TSelection;
    pendingBatch: InboxMessage[];
    work: Awaited<ReturnType<typeof workBatch>>;
  };
  async function selectForPreparation(
    threadId: ThreadId,
    at: "run_start",
    retry?: boolean,
  ): Promise<SelectedDelivery<DeliverySelection>>;
  async function selectForPreparation(
    threadId: ThreadId,
    at: "boundary" | "prefix",
  ): Promise<SelectedDelivery<DeliveryBoundarySelection>>;
  async function selectForPreparation(
    threadId: ThreadId,
    at: "run_start" | "boundary" | "prefix",
    retry = false,
  ): Promise<SelectedDelivery<DeliverySelection | DeliveryBoundarySelection>> {
    const { pendingBatch, boundIds, eligible } = await eligiblePending(threadId);
    // Materialization puts every waiting non-command row into the graph in seq
    // order; it is not a request boundary, so a queued switch never yields it.
    const nextWork: InboxWorkSelection =
      at === "prefix" ? prefixRows(eligible) : next(eligible, at, retry);
    const control = at === "run_start" && nextWork.kind === "control" ? nextWork.control : null;
    const rows = nextWork.kind === "batch" || nextWork.kind === "control" ? nextWork.rows : [];
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
      workContext: work.workContext,
      notices,
      activeLeafTurnId: thread.activeLeafTurnId,
    };
    const selection: DeliverySelection | DeliveryBoundarySelection =
      at === "run_start"
        ? { ...selectionFields, next: nextWork }
        : { ...selectionFields, yieldReply: nextWork.kind === "yield" };
    return { selection, pendingBatch, work };
  }
  async function eligiblePending(threadId: ThreadId) {
    const pendingBatch = await inbox.selectPending(threadId);
    const projection = await inbox.readPendingProjection(threadId);
    const boundIds = new Set(projection.run?.messageIds ?? []);
    return {
      pendingBatch,
      boundIds,
      eligible: pendingBatch.filter((row) => !boundIds.has(row.id)),
    };
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
    /** `lockHeld`: the thread lock is already taken (the last, locked attempt). */
    select: (lockHeld: boolean) => Promise<SelectedDelivery<TSelection>>;
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
    return attemptPreparation();

    async function attemptPreparation(): Promise<TResult> {
      for (let attempt = 0; attempt < PREPARATION_ATTEMPTS; attempt += 1) {
        const lockedPreparation = attempt === PREPARATION_ATTEMPTS - 1;
        if (lockedPreparation) {
          return threadLock.withThreadLock(input.threadId, async () => {
            const selected = await input.select(true);
            input.signal?.throwIfAborted();
            const prepared = await input.prepare(selected.selection, selected.work);
            input.signal?.throwIfAborted();
            await input.validate?.();
            return commitSelected(selected, prepared);
          });
        }

        const selected = await input.select(false);
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
      const result = await input.commit(selected.selection, selected.work, prepared);
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
    const { selection, work } = await selectForPreparation(threadId, "prefix");
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
    await ack(threadId, work.ids);
    await appendPending(threadId);
  }
  async function materializeIdle(threadId: ThreadId) {
    await deps.runClaim.withExclusiveThread(threadId, async () => {
      await settleStaleExecution(threadId);
      await threadLock.withThreadLock(threadId, async () => {
        if (await inbox.canMaterializeWork(threadId)) await materializePrefix(threadId);
      });
    });
    return (await inbox.selectPending(threadId)).some(
      (message) => message.body.kind === "work_context_refresh",
    )
      ? ("pending" as const)
      : ("delivered" as const);
  }
  /**
   * The admitted run-start boundary's switch rule. Under the run's claim and
   * after the start refusals, the queued write-mode switch applies in one
   * transaction (the chat's mode, the switch turn at the active leaf, the
   * control's ack) when `next` says a run follows it, or a Retry runs. A
   * switch queued while setup was in flight is found by the retry loop in
   * `prepareAndCommit`, whose commit validates this very selection.
   */
  async function selectRunStart(threadId: ThreadId, retry: boolean, lockHeld: boolean) {
    for (;;) {
      const apply = () => applyDueSwitch(threadId, retry);
      if (lockHeld) await apply();
      else await threadLock.withThreadLock(threadId, apply);
      const selected = await selectForPreparation(threadId, "run_start", retry);
      if (selected.selection.next.kind !== "switch") return selected;
    }
  }
  async function applyDueSwitch(threadId: ThreadId, retry: boolean): Promise<boolean> {
    const selected = next(await inbox.selectPending(threadId), "run_start", retry);
    if (selected.kind !== "switch") return false;
    const control = selected.control;
    const thread = await deps.repos.threads.findById(threadId);
    if (!thread) return false;
    const mode = control.body.mode;
    const leaf = thread.activeLeafTurnId as TurnId | null;
    const leafTurn = leaf ? await deps.repos.turns.findById(leaf) : null;
    if (leaf && !leafTurn) throw new Error(`Missing causal turn: ${leaf}`);
    const { turn, block } = writeModeSwitchTurn({
      threadId,
      prevTurnId: leaf,
      position: nextTurnPosition(leafTurn),
      mode,
      controlMessageId: control.id,
      notice: await deps.writeModeSwitch.renderNotice(threadId, mode),
    });
    await persistAndAppendTurnStartEvents(deps, threadId, leaf, async () => {
      await deps.repos.threads.setAiWriteMode(threadId, mode);
      return {
        result: undefined,
        events: [
          { type: "turn.created" as const, turn },
          { type: "block.upserted" as const, block },
        ],
      };
    });
    await ack(threadId, [control.id]);
    await appendPending(threadId);
    return true;
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
    kind: "adopt";
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
      orderedBatch.some(
        (message) => message.intent === "message" && !input.knownTurnIds.has(message.id),
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
      kind: "adopt",
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
    // Adopted reference reads count as shown only with the commit that
    // persists their blocks; a discarded or retried preparation records nothing.
    const recordShown = async (turnId: TurnId) => {
      if (!drain.shown?.length) return;
      if (!input.recordShown)
        throw new Error("Adopted reference reads have no shown-link recorder");
      await input.recordShown(turnId, drain.shown);
    };

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
        await persistAndAppendTurnStartEvents(
          deps,
          threadId,
          expectedLeaf,
          async () => ({
            result: undefined,
            events: [
              ...(input.current.kind === "assistant"
                ? [{ type: "turn.completed" as const, turn: completed ?? currentTurn }]
                : []),
              ...events,
            ],
          }),
          { afterEvents: () => recordShown(currentTurn.id) },
        );
        await ack(threadId, drain.ackIds, deliveredBy(lease, currentTurn));
        drain.ackIds = [];
        await endExecution(lease);
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
            identity: {
              executionId: lease.executionId,
              reservedForUserTurnIds: [
                ...new Set([
                  ...(input.carriedReservedForUserTurnIds ?? []),
                  ...adoption.selection.outstanding.map(({ id }) => id),
                ]),
              ],
            },
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
              await recordShown(next.id);
              await leaseStore.bindTurn(lease, next.id, drain.ackIds, currentTurnKind(next));
              if (adoption.selection.outstanding.length > 0)
                await input.admit?.(next, adoption.selection.outstanding);
            },
          },
        );
      }
      if (input.current.kind === "assistant") await deps.repos.threads.updateCost(threadId, "0", 1);
    } else if (events.length > 0) {
      await persistAndAppendEvents(deps, threadId, async () => ({ result: undefined, events }), {
        afterEvents: () => recordShown(currentTurn.id),
      });
    }

    await ack(threadId, work.ids);
    if (
      !split &&
      batch.length > 0 &&
      !(await leaseStore.setAdoptedMessageIds(lease, drain.ackIds))
    ) {
      throw new Error("Cannot adopt inbox batch after losing live run lease");
    }
    if (input.current.kind === "placeholder" && !terminal && preparationFailure !== undefined) {
      const error = preparationFailureError(
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
        },
      });
      next = completion.turn;
      await ack(threadId, drain.ackIds, deliveredBy(lease, next));
      // The failed successor is the execution's last turn: it ends in this
      // commit, and the run exits on the terminal disposition, not a throw.
      await endExecution(lease);
      terminal = true;
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

  type PreparedYield<TCurrent> = {
    kind: "yield";
    preparedCurrent?: TCurrent;
    currentFailure?: unknown;
  };

  /** A placeholder finishes through its own callbacks; an assistant needs nothing prepared. */
  async function prepareYield<TCurrent>(
    input: DeliveryBoundary<TCurrent>,
  ): Promise<PreparedYield<TCurrent>> {
    if (input.current.kind === "assistant") return { kind: "yield" };
    try {
      return { kind: "yield", preparedCurrent: await input.prepareCurrent?.() };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      return { kind: "yield", currentFailure: error };
    }
  }

  /**
   * Ends the reply at this request boundary because a message waits behind a
   * queued switch. Nothing is adopted and no successor is reserved: the
   * assistant exits through the run's ordinary success close, and a
   * placeholder completes with its own outcome before the claim is released.
   * Its receipt stays unacknowledged, so those messages wait for the next run.
   */
  async function commitYield<TCurrent>(
    input: DeliveryBoundary<TCurrent>,
    prepared: PreparedYield<TCurrent>,
  ): Promise<AdoptedBatch<TCurrent>> {
    const drain = { turns: [], blocks: [], events: [], ackIds: [] };
    if (input.current.kind === "assistant")
      return { drain, next: input.currentTurn, split: false, yielded: true };
    const completed = await input.current.complete(
      prepared.preparedCurrent,
      prepared.currentFailure,
    );
    await endExecution(input.lease);
    await appendPending(input.lease.threadId);
    return {
      drain,
      next: completed,
      completed,
      split: true,
      terminal: true,
      yielded: true,
      preparedCurrent: prepared.preparedCurrent,
    };
  }

  async function adopt<TCurrent>(
    input: DeliveryBoundary<TCurrent>,
  ): Promise<AdoptedBatch<TCurrent>> {
    return prepareAndCommit({
      threadId: input.lease.threadId,
      select: () => selectForPreparation(input.lease.threadId, "boundary"),
      signal: input.signal,
      // Cancellation wins over a yield: it is checked under the lock first.
      validate: async () => {
        if ((await leaseStore.lockReceipt(input.lease))?.cancelRequested)
          throw new DOMException("The operation was aborted", "AbortError");
      },
      prepare: (selection, work): Promise<PreparedAdoption<TCurrent> | PreparedYield<TCurrent>> =>
        selection.yieldReply ? prepareYield(input) : prepareAdoption(input, selection, work),
      // A yield consumes no peeked notices; they wait for the next reply.
      hasPreparationFailure: (prepared) =>
        prepared.kind === "yield" || prepared.preparationFailure !== undefined,
      commit: async (_selection, _work, prepared) =>
        prepared.kind === "yield" ? commitYield(input, prepared) : commitAdoption(input, prepared),
    });
  }

  async function hasCompletedReplyInLineage(threadId: ThreadId): Promise<boolean> {
    let thread = await deps.repos.threads.findByIdIncludingDeleted(threadId);
    let throughPosition = Number.POSITIVE_INFINITY;
    const visited = new Set<string>();
    while (thread && !visited.has(thread.id)) {
      visited.add(thread.id);
      const localTurns = await deps.repos.turns.listByThread(thread.id as ThreadId);
      if (
        localTurns.some(
          (turn) =>
            turn.position <= throughPosition &&
            turn.role === "assistant" &&
            turn.status === "complete",
        )
      )
        return true;
      if (thread.originType !== "fork" || !thread.originTurnId) return false;
      const cutoff = await deps.repos.turns.findById(thread.originTurnId as TurnId);
      if (!cutoff) return false;
      thread = await deps.repos.threads.findByIdIncludingDeleted(cutoff.threadId as ThreadId);
      throughPosition = cutoff.position;
    }
    return false;
  }

  /** A failed or cancelled assistant delivers its messages: they are never taken on again. */
  async function acknowledgeFailedReply(lease: Lease, turn: Turn, messageIds: readonly string[]) {
    if (turn.role === "assistant" && (turn.status === "cancelled" || turn.status === "error"))
      await ack(lease.threadId, messageIds, deliveredBy(lease, turn));
  }

  return {
    ...createThreadControls({
      withThreadLock: threadLock.withThreadLock,
      findMessage: inbox.findMessage,
      enqueue,
      // A switch never wakes the chat: it waits for the run something else starts.
      async enqueueWithoutWake(draft) {
        const message = await inbox.enqueue(draft);
        await appendPending(draft.threadId);
        return message;
      },
      async enqueueSettled(draft, cancelledIds) {
        const message = await inbox.enqueue(draft);
        await ack(draft.threadId, [...cancelledIds, message.id]);
        await appendPending(draft.threadId);
      },
      selectPending: inbox.selectPending,
      async threadWriteMode(threadId) {
        const thread = await deps.repos.threads.findById(threadId);
        if (!thread) throw new Error(`Thread not found: ${threadId}`);
        return thread.aiWriteMode;
      },
      headSeq: deps.headSeq,
      async setWorkDefault(threadId, mode) {
        const thread = await deps.repos.threads.findById(threadId);
        if (thread?.workId)
          await deps.writeModeSwitch.setWorkDefault(thread.workId as WorkId, mode);
      },
      findControlTurn: (id, controlId) => deps.repos.turns.findByControlId(id, controlId),
      pending: (id) => readPendingInbox(inbox, id),
      acknowledge: async (id, controlIds) => {
        await ack(id, controlIds);
        await appendPending(id);
      },
      hasCompletedReply: hasCompletedReplyInLineage,
    }),
    threadChanged,
    async workChanged(workId, origin) {
      const mutationId = crypto.randomUUID();
      for (const threadId of await inbox.workNoticeTargets(workId)) {
        if (threadId === origin?.originThreadId) continue;
        await threadChanged(threadId, mutationId);
      }
    },
    materializeIdle,
    async yieldsAtBoundary(threadId) {
      return next((await eligiblePending(threadId)).eligible, "boundary").kind === "yield";
    },
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
    settleStaleExecution,
    releaseExecution,
    blockForUsage: (lease) =>
      threadLock.withThreadLock(lease.threadId, async () => {
        const receipt = await leaseStore.lockReceipt(lease);
        const projection = await inbox.readPendingProjection(lease.threadId);
        if (
          !receipt ||
          !projection.messages.some(
            (message) => message.intent === "message" || message.intent === "control",
          ) ||
          projection.run?.turnId ||
          projection.blocked?.reason === "credits_exhausted"
        )
          return;
        await inbox.setBlockedReason(lease.threadId, "credits_exhausted");
        await appendPending(lease.threadId);
      }),
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
          // No reserved turn delivers these (a child run aborted before its reservation).
          async acknowledge(ids) {
            await ack(threadId, ids);
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
        select: (lockHeld) => selectRunStart(lease.threadId, !!options?.retry, lockHeld),
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
          await ack(lease.threadId, work.ids);
          await ack(lease.threadId, prepared.completedControlIds ?? []);
          await leaseStore.bindTurn(
            lease,
            prepared.turnId,
            prepared.messageIds.filter(
              (id) => !work.ids.includes(id) && !prepared.completedControlIds?.includes(id),
            ),
            prepared.turnKind,
          );
          await inbox.setBlockedReason(lease.threadId, null);
          await appendPending(lease.threadId);
          return { value: prepared.value };
        },
      });
      if (!result) throw new NoPendingWakeError(lease.threadId);
      return result.value;
    },
    ackWithResponse: (lease, ids, byTurn, persist) =>
      threadLock.withThreadLock(lease.threadId, async () => {
        const result = await persist();
        if (ids.length > 0) {
          if (!(await leaseStore.clearReceipt(lease, ids)))
            throw new Error("Cannot ack after losing live run lease");
          await ack(lease.threadId, ids, deliveredBy(lease, byTurn));
          await appendPending(lease.threadId);
        }
        return result;
      }),
    splitAndContinue: (input) => adopt(input),
    close: async (input) => {
      const threadId = input.lease.threadId;
      // Serialize the terminal decision with cancellation, not only the loop's
      // cached flag: the durable flag for a remote Stop, the local signal for
      // a parent's cancel or shutdown.
      const terminalCause = (receipt: { cancelRequested: boolean } | null) =>
        receipt?.cancelRequested
          ? { kind: "cancelled" as const, reason: "cancelled" }
          : (input.localCancellation?.() ?? input.cause);
      const disposition = await threadLock.withThreadLock(threadId, async () => {
        const receipt = await leaseStore.lockReceipt(input.lease);
        const cause = terminalCause(receipt);
        if (input.continueWith && cause.kind === "success") {
          // A yield selects no rows, so the reply closes here with no successor.
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
          cause,
        });
        await acknowledgeFailedReply(input.lease, completion.turn, receipt?.ids ?? []);
        await endExecution(input.lease);
        await appendPending(threadId);
        return { kind: "completed" as const, completion };
      });
      if (disposition.kind === "completed") return disposition;

      const boundary = input.continueWith as DeliveryBoundary;
      const adopted = await adopt(boundary);
      if (adopted.split) return { kind: "split", adopted };
      const completion = await threadLock.withThreadLock(threadId, async () => {
        const receipt = await leaseStore.lockReceipt(input.lease);
        const result = await finalizeExecution(deps, {
          threadId,
          turnId: input.turnId,
          cause: terminalCause(receipt),
        });
        await acknowledgeFailedReply(input.lease, result.turn, receipt?.ids ?? []);
        await endExecution(input.lease);
        await appendPending(threadId);
        return result;
      });
      return { kind: "completed", completion };
    },
  };
}

function prefixRows(eligible: readonly InboxMessage[]): InboxWorkSelection {
  const rows = eligible.filter((row) => row.intent !== "control");
  return rows.length > 0 ? { kind: "batch", rows } : { kind: "none" };
}

function sameInboxBatch(left: readonly InboxMessage[], right: readonly InboxMessage[]): boolean {
  return (
    left.length === right.length && left.every((message, index) => message.id === right[index]?.id)
  );
}
