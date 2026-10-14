/** Shared delivery transitions. Concrete adapters supply one compatible transaction/store bundle. */

import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import type {
  HandBackRequest,
  HandBackResponse,
  RunState,
  StopRequest,
  StopResponse,
} from "@meridian/contracts/threads";
import { isPendingPlaceholder, isTerminalTurnStatus, type Turn } from "@meridian/contracts/threads";
import type { NoticePort } from "../../notices/index.js";
import { SystemUpdateMetadataCodec } from "../../threads/index.js";
import { nextTurnPosition } from "../../threads/order-turns.js";
import { turnGraph } from "../../threads/ports/turn-graph.js";
import type { DetachedWorkTracker } from "../detached-work.js";
import { finalizeExecution } from "../loop/execution-finalizer.js";
import { drainInbox, planMessageTurns } from "../loop/inbox-context.js";
import { currentTurnKind, reservationTurn } from "../loop/local-turn.js";
import { type InboxWorkSelection, next } from "../loop/next-inbox-work.js";
import { finalizeOrphanedTurns } from "../loop/orphaned-placeholder.js";
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
import { HandBackConflictError } from "../loop/runtime-delivery.js";
import {
  decideHandBack,
  decideStop,
  type HandBackScopeFacts,
  handBackFingerprint,
  type StopDecision,
  type StopFacts,
} from "../loop/stop-rule.js";
import { createThreadControls } from "../loop/thread-controls.js";
import type { ThreadLock } from "../loop/thread-lock.js";
import { type WriteModeSwitchPort, writeModeSwitchTurn } from "../loop/write-mode-switch.js";

/** Adapter-private storage primitives; never injected into the model loop or producers. */
export interface DeliveryStore extends InboxReader {
  setBlockedReason(threadId: ThreadId, reason: "credits_exhausted" | null): Promise<void>;
  /**
   * Records that a write outside this store (the chat's write mode) changed an input of the chat's
   * run-state record, so the transaction publishes a fresh record. Call under the thread lock.
   */
  markRunStateChanged(threadId: ThreadId): void;
  /** Appends the chat's run-state record now, under its lock; returns its stream version (null: none). */
  publishRunState(threadId: ThreadId): Promise<string | null>;
  /** The record a command answers with, under the chat's lock; see `answerRunState`. */
  answerRunState(threadId: ThreadId): Promise<RunState>;
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
  ack(
    threadId: ThreadId,
    ids: string[],
    byTurnId?: TurnId | null,
    /** Takes writer messages out of the chat instead of delivering them: no deliverer, `handed_back_by` set. */
    options?: { handedBackBy?: string },
  ): Promise<string[]>;
}

/** What a hand-back request decided, stored by request id so a replay answers the same. */
export type StoredHandBack = {
  fingerprint: string;
  handedBack: string[];
  answered: string[];
  gone: string[];
  cancelledExecutionId: string | null;
};

/** Adapter-private storage for hand-back and Stop; every method runs under the chat's thread lock. */
export interface HandBackStore {
  find(threadId: ThreadId, requestId: string): Promise<StoredHandBack | null>;
  /** The lease, its receipt and the writer messages a request's scope could cover (see `StopFacts`). */
  readFacts(threadId: ThreadId, scope: HandBackScopeFacts): Promise<StopFacts>;
  record(
    threadId: ThreadId,
    requestId: string,
    fingerprint: string,
    decision: {
      handBack: string[];
      answered: string[];
      gone: string[];
      cancelledExecutionId?: string | null;
    },
  ): Promise<void>;
  /** Sets `cancel_requested` on the lease row of this execution, expiry ignored. */
  cancelExecution(threadId: ThreadId, executionId: string): Promise<boolean>;
  /** The writer's message blocks of these user turns, in the order given. */
  contentOf(
    userTurnIds: readonly string[],
  ): Promise<{ userTurnId: string; blocks: HandBackResponse["handedBack"][number]["blocks"] }[]>;
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
    /** Absent where hand-back is not supported (the in-memory harness). */
    handBacks?: HandBackStore;
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
    writeModeSwitch: WriteModeSwitchPort;
  },
): RuntimeDelivery {
  const { inbox, leaseStore, threadLock } = deps;
  const backgroundTasks = deps.backgroundTasks;
  const schedulePostCommit = (task: () => Promise<void>) =>
    deps.schedulePostCommit(() =>
      backgroundTasks.track(Promise.resolve().then(task), "runtime delivery callback"),
    );
  /** The turn current when an execution acknowledges messages, and its execution. */
  type Deliverer = { turn: { id: string; position: number | null }; executionId: string | null };
  const deliveredBy = (lease: Lease, turn: Pick<Turn, "id" | "position">): Deliverer => ({
    turn,
    executionId: lease.executionId,
  });
  /**
   * The one acknowledgement path. Message rows this call actually delivers record their
   * deliverer; controls and notices record nothing. The inbox write marks the chat, so the
   * transaction publishes the record. Every retirement path goes through here under the
   * caller's thread lock, so a usage block is cleared the moment no message or control waits
   * behind it.
   */
  const ack = async (threadId: ThreadId, ids: readonly string[], by: Deliverer | null = null) => {
    if (ids.length > 0) await inbox.ack(threadId, [...ids], (by?.turn.id as TurnId) ?? null);
    await clearBlockWhenIdle(threadId);
  };
  /** A usage block clears the moment no message or control waits behind it. */
  const clearBlockWhenIdle = async (threadId: ThreadId) => {
    const projection = await inbox.readPendingProjection(threadId);
    if (
      !projection.messages.some(
        (message) => message.intent === "message" || message.intent === "control",
      )
    )
      await inbox.setBlockedReason(threadId, null);
  };
  /**
   * Ends an execution in the transaction that wrote its last terminal turn: deletes the lease
   * row, whose release marks the chat so that transaction publishes the closed record.
   */
  async function endExecution(lease: Lease) {
    await deps.runClaim.release(lease);
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
      await leaseStore.deleteStaleExecution(threadId, stale.executionId);
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
  ): Promise<SelectedDelivery<DeliverySelection>>;
  async function selectForPreparation(
    threadId: ThreadId,
    at: "boundary" | "prefix",
  ): Promise<SelectedDelivery<DeliveryBoundarySelection>>;
  async function selectForPreparation(
    threadId: ThreadId,
    at: "run_start" | "boundary" | "prefix",
  ): Promise<SelectedDelivery<DeliverySelection | DeliveryBoundarySelection>> {
    const { pendingBatch, boundIds, eligible } = await eligiblePending(threadId);
    // Materialization puts every waiting non-command row into the graph in seq
    // order; it is not a request boundary, so a queued switch never yields it.
    const nextWork: InboxWorkSelection =
      at === "prefix" ? prefixRows(eligible) : next(eligible, at);
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
    select: () => Promise<SelectedDelivery<TSelection>>;
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
            const selected = await input.select();
            input.signal?.throwIfAborted();
            const prepared = await input.prepare(selected.selection, selected.work);
            input.signal?.throwIfAborted();
            await input.validate?.();
            return commitSelected(selected, prepared);
          });
        }

        const selected = await input.select();
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
      work.batch.map((message) => turnGraph(deps.repos.turns).findById(message.id)),
    );
    const leaf = selection.activeLeafTurnId;
    const leafTurn = leaf ? await turnGraph(deps.repos.turns).findById(leaf) : null;
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
   * Applies the chat's due write-mode switches while no reply holds it. Each
   * switch is one transaction: the chat's mode, its Work's default (thread
   * then Work), the switch turn at the active leaf, and the control's ack. No
   * model call and no lease: a reply never sees its mode change.
   */
  async function applyDueSwitches(threadId: ThreadId) {
    const ran = await deps.runClaim.withExclusiveThread(threadId, async () => {
      await settleStaleExecution(threadId);
      while (await threadLock.withThreadLock(threadId, () => applyDueSwitch(threadId))) {}
      return true;
    });
    return ran === true;
  }
  async function applyDueSwitch(threadId: ThreadId): Promise<boolean> {
    const selected = next(await inbox.selectPending(threadId), "run_start");
    if (selected.kind !== "switch") return false;
    const thread = await deps.repos.threads.findById(threadId);
    if (!thread) return false;
    const { control } = selected;
    const mode = control.body.mode;
    const leaf = thread.activeLeafTurnId as TurnId | null;
    const leafTurn = leaf ? await turnGraph(deps.repos.turns).findById(leaf) : null;
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
      inbox.markRunStateChanged(threadId);
      if (thread.workId) await deps.writeModeSwitch.setWorkDefault(thread.workId as WorkId, mode);
      return {
        result: undefined,
        events: [
          { type: "turn.created" as const, turn },
          { type: "block.upserted" as const, block },
        ],
      };
    });
    await ack(threadId, [control.id]);
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
    const expectedLeafTurn = expectedLeaf
      ? await turnGraph(deps.repos.turns).findById(expectedLeaf)
      : null;
    if (expectedLeaf && !expectedLeafTurn) throw new Error(`Missing causal turn: ${expectedLeaf}`);
    let leaf: TurnId | null = expectedLeaf;
    while (leaf && !input.knownTurnIds.has(leaf)) {
      const turn = await turnGraph(deps.repos.turns).findById(leaf);
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
      const cutoff = await turnGraph(deps.repos.turns).findById(thread.originTurnId as TurnId);
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

  const requireHandBacks = () => {
    if (!deps.handBacks) throw new Error("Hand-back is not configured for this delivery adapter");
    return deps.handBacks;
  };
  /** A stored decision as the answer: the content comes from the immutable turns, the record is fresh. */
  async function storedHandBack(threadId: ThreadId, stored: StoredHandBack) {
    const handedBack = await requireHandBacks().contentOf(stored.handedBack);
    return {
      handedBack,
      answered: stored.answered,
      gone: stored.gone,
      cancelledExecutionId: stored.cancelledExecutionId,
      runState: await inbox.answerRunState(threadId),
    };
  }
  /**
   * One hand-back request, decided once under the thread lock from rows and stored by request id.
   * A replay with the same body returns the stored decision and flags nothing; another body is a
   * conflict. The decision is judged on the facts before any write, then applied: the stored row
   * first (the inbox rows reference it), the acknowledgements, the compaction receipt strip, the
   * journal event, and the execution's cancel flag.
   */
  function handBackRequest(
    threadId: ThreadId,
    input: {
      requestId: string;
      fingerprint: string;
      scope: HandBackScopeFacts;
      decide(facts: StopFacts): StopDecision;
    },
  ) {
    return threadLock.withThreadLock(threadId, async () => {
      const store = requireHandBacks();
      const stored = await store.find(threadId, input.requestId);
      if (stored) {
        if (stored.fingerprint !== input.fingerprint)
          throw new HandBackConflictError(input.requestId);
        return storedHandBack(threadId, stored);
      }
      const facts = await store.readFacts(threadId, input.scope);
      const decision = input.decide(facts);
      await store.record(threadId, input.requestId, input.fingerprint, {
        ...decision,
        cancelledExecutionId: decision.cancelExecutionId,
      });
      if (decision.handBack.length > 0) {
        await inbox.ack(threadId, decision.handBack, null, { handedBackBy: input.requestId });
        // A cancelled compaction gives back what it had taken on; nothing would answer it.
        const taken = decision.handBack.filter((id) => facts.receipt.includes(id));
        if (taken.length > 0) {
          const receipt = await leaseStore.lockThreadReceipt(threadId);
          if (receipt)
            await leaseStore.setAdoptedMessageIds(
              receipt.lease,
              receipt.ids.filter((id) => !taken.includes(id)),
            );
        }
        await deps.eventWriter.appendEvent(threadId, {
          type: "messages.handed_back",
          userTurnIds: decision.handBack,
          requestId: input.requestId,
        });
        await clearBlockWhenIdle(threadId);
      }
      if (decision.cancelExecutionId)
        await store.cancelExecution(threadId, decision.cancelExecutionId);
      return storedHandBack(threadId, {
        fingerprint: input.fingerprint,
        handedBack: decision.handBack,
        answered: decision.answered,
        gone: decision.gone,
        cancelledExecutionId: decision.cancelExecutionId,
      });
    });
  }

  return {
    ...createThreadControls({
      withThreadLock: threadLock.withThreadLock,
      findMessage: inbox.findMessage,
      enqueue,
      // The control route applies an idle switch itself; a reply's release
      // wake reaches one the reply kept from it.
      async enqueueWithoutWake(draft) {
        const message = await inbox.enqueue(draft);
        return message;
      },
      async enqueueSettled(draft, cancelledIds) {
        const message = await inbox.enqueue(draft);
        await ack(draft.threadId, [...cancelledIds, message.id]);
      },
      selectPending: inbox.selectPending,
      async threadWriteMode(threadId) {
        const thread = await deps.repos.threads.findById(threadId);
        if (!thread) throw new Error(`Thread not found: ${threadId}`);
        return thread.aiWriteMode;
      },
      applyDueSwitches,
      replyHolds: async (id) => (await deps.runClaim.holder(id)) !== null,
      findControlTurn: (id, controlId) => deps.repos.turns.findByControlId(id, controlId),
      answerRunState: inbox.answerRunState,
      acknowledge: (id, controlIds) => ack(id, controlIds),
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
    applyDueSwitches,
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
      }),
    selectPending: inbox.selectPending,
    readPendingProjection: inbox.readPendingProjection,
    pendingMessageThreads: async (limit, afterThreadId) => {
      return inbox.pendingMessageThreads(limit, afterThreadId);
    },
    enqueue: (draft) => threadLock.withThreadLock(draft.threadId, () => enqueue(draft)),
    answerRunState: (threadId) =>
      threadLock.withThreadLock(threadId, () => inbox.answerRunState(threadId)),
    async handBack(threadId, request: HandBackRequest): Promise<HandBackResponse> {
      const scope: HandBackScopeFacts =
        request.scope.kind === "ids"
          ? { kind: "ids", ids: request.scope.ids }
          : { kind: "seen", seenThrough: request.scope.seenThrough, mine: request.scope.mine };
      const { handedBack, answered, gone, runState } = await handBackRequest(threadId, {
        requestId: request.requestId,
        fingerprint: handBackFingerprint({ kind: "hand_back", scope }),
        scope,
        // The x and Cancel queue never cancel the execution.
        decide: (facts) => ({ ...decideHandBack(facts, scope, false), cancelExecutionId: null }),
      });
      return { handedBack, answered, gone, runState };
    },
    async stop(threadId, request: StopRequest): Promise<StopResponse> {
      const scope: HandBackScopeFacts = {
        kind: "seen",
        seenThrough: request.seenThrough,
        mine: request.mine,
      };
      const result = await handBackRequest(threadId, {
        requestId: request.requestId,
        fingerprint: handBackFingerprint({
          kind: "stop",
          scope,
          seenExecutionId: request.seenExecutionId,
        }),
        scope,
        decide: (facts) =>
          decideStop(facts, {
            seenThrough: request.seenThrough,
            seenExecutionId: request.seenExecutionId,
            mine: request.mine,
          }),
      });
      return { threadId, ...result };
    },
    withThreadLock: (threadId, operation) =>
      threadLock.withThreadLock(threadId, () =>
        operation({
          materializePrefix: () => materializePrefix(threadId),
          publishRunState: () => inbox.publishRunState(threadId),
          // No reserved turn delivers these (a child run aborted before its reservation).
          async acknowledge(ids) {
            await ack(threadId, ids);
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
        select: () => selectForPreparation(lease.threadId, "run_start"),
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
