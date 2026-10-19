/** Shared delivery transitions. Concrete adapters supply one compatible transaction/store bundle. */

import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { type Block, isPendingPlaceholder } from "@meridian/contracts/threads";
import type { NoticePort } from "../../notices/index.js";
import { hasCompletedReplyInLineage, SystemUpdateMetadataCodec } from "../../threads/index.js";
import { nextTurnPosition } from "../../threads/order-turns.js";
import { turnGraph } from "../../threads/ports/turn-graph.js";
import type { DetachedWorkTracker } from "../detached-work.js";
import { finalizeExecution } from "../loop/execution-finalizer.js";
import { drainInbox, planMessageTurns } from "../loop/inbox-context.js";
import { latestRowAt } from "../loop/latest-row.js";
import { currentTurnKind, reservationTurn } from "../loop/local-turn.js";
import {
  type InboxWorkSelection,
  next,
  prefixRows,
  type WriteModeSwitchMessage,
} from "../loop/next-inbox-work.js";
import { persistAndAppendEvents, persistAndAppendTurnStartEvents } from "../loop/persistence.js";
import type { InboxMessage, MessageDraft, RunClaim, RunStarter } from "../loop/ports.js";
import { preparationFailureError } from "../loop/preparation-failure.js";
import { hasReferenceEvidence } from "../loop/reference-context.js";
import { NoPendingWakeError, ReplyRetryUnavailableError } from "../loop/run-turn-port.js";
import type {
  AdoptedBatch,
  DeliveryBoundary,
  DeliveryBoundarySelection,
  DeliverySelection,
  DeliverySelectionFields,
  RuntimeDelivery,
} from "../loop/runtime-delivery.js";
import { createThreadControls } from "../loop/thread-controls.js";
import { type WriteModeSwitchPort, writeModeSwitchTurn } from "../loop/write-mode-switch.js";
import type { HandBackStore } from "./delivery-ports.js";
import { createExecutionSettlement, type ExecutionSettlementDeps } from "./execution-settlement.js";
import { createThreadCommands } from "./thread-commands.js";

const PREPARATION_ATTEMPTS = 3;

export function createDeliveryAdapter(
  deps: ExecutionSettlementDeps & {
    backgroundTasks: DetachedWorkTracker;
    /** Absent where hand-back is not supported (the in-memory harness). */
    handBacks?: HandBackStore;
    runClaim: Pick<
      RunClaim,
      "release" | "abandon" | "withExclusiveThread" | "cancelExecution" | "holder"
    >;
    workContext: import("../loop/work-context.js").WorkContextReader;
    notices: NoticePort;
    runStarter: RunStarter;
    writeModeSwitch: WriteModeSwitchPort;
  },
): RuntimeDelivery {
  const { inbox, leaseStore, threadLock } = deps;
  const schedulePostCommit = (task: () => Promise<void>) =>
    deps.schedulePostCommit(() =>
      deps.backgroundTasks.track(Promise.resolve().then(task), "runtime delivery callback"),
    );
  const settlement = createExecutionSettlement({ ...deps, schedulePostCommit });
  const { ack, deliveredBy, endExecution, settleStaleExecution } = settlement;
  type SelectedDelivery<TSelection> = {
    selection: TSelection;
    pendingBatch: InboxMessage[];
    work: Awaited<ReturnType<typeof workBatch>>;
    /** A due switch applies only with the reservation, so preparation must hold the thread lock. */
    requiresLock?: boolean;
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
      for (let attempt = 0; attempt < PREPARATION_ATTEMPTS - 1; attempt += 1) {
        const selected = await input.select(false);
        if (selected.requiresLock) break;
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
      // The last attempt prepares under the lock, so nothing can change between selection and commit.
      return threadLock.withThreadLock(input.threadId, async () => {
        const selected = await input.select(true);
        input.signal?.throwIfAborted();
        const prepared = await input.prepare(selected.selection, selected.work);
        input.signal?.throwIfAborted();
        await input.validate?.();
        return commitSelected(selected, prepared);
      });
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
   * The admitted run-start boundary's switch rule. A due write-mode switch (`next`
   * says a run follows it, or a Retry runs) applies in the same thread-lock
   * transaction that reserves the run: the chat's mode, the switch turn at the
   * active leaf and the control's ack commit with the reservation, or none do.
   * Preparation reads storage, so it can't run under the lock for every start;
   * an optimistic attempt that finds a due switch asks for the locked attempt
   * instead and applies nothing. A Retry whose leaf moved is refused before the
   * switch applies, leaving it pending.
   */
  async function selectRunStart(
    threadId: ThreadId,
    retryOf: TurnId | undefined,
    lockHeld: boolean,
  ) {
    for (;;) {
      const selected = await selectForPreparation(threadId, "run_start", !!retryOf);
      const due = selected.selection.next;
      if (due.kind !== "switch") {
        await assertRetryLeaf(threadId, selected.selection.activeLeafTurnId, retryOf);
        return selected;
      }
      if (!lockHeld) return { ...selected, requiresLock: true };
      await applyDueSwitch(threadId, due.control, retryOf);
    }
  }
  /**
   * Retry's compare-and-swap: only turns that don't close the failed reply (a switch, a Work refresh, a
   * notice) may trail it. A newer message or another Retry moved the leaf, so the Retry is refused.
   */
  async function assertRetryLeaf(threadId: ThreadId, leaf: TurnId | null, retryOf?: TurnId) {
    if (!retryOf) return;
    const { latest } = await latestRowAt(deps.repos.turns, leaf);
    if (latest?.id !== retryOf) throw new ReplyRetryUnavailableError(threadId);
  }
  /** Runs under the thread lock the run's reservation also commits in. */
  async function applyDueSwitch(
    threadId: ThreadId,
    control: WriteModeSwitchMessage,
    retryOf?: TurnId,
  ) {
    const thread = await deps.repos.threads.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const mode = control.body.mode;
    const leaf = thread.activeLeafTurnId as TurnId | null;
    await assertRetryLeaf(threadId, leaf, retryOf);
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
      return {
        result: undefined,
        events: [
          { type: "turn.created" as const, turn },
          { type: "block.upserted" as const, block },
        ],
      };
    });
    await ack(threadId, [control.id]);
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
    const recordEvidence = async (turnId: TurnId) => {
      if (!drain.evidence || !hasReferenceEvidence(drain.evidence)) return;
      if (!input.recordEvidence)
        throw new Error("Adopted reference reads have no evidence recorder");
      await input.recordEvidence(turnId, drain.evidence);
    };

    const receipt = await leaseStore.lockReceipt(lease);
    drain.ackIds = [...new Set([...(receipt?.ids ?? []), ...drain.ackIds])].filter(
      (id) => !work.ids.includes(id) && !committedWorkIds.includes(id),
    );
    let terminal = false;
    let completedBlocks: Block[] = [];
    if (split) {
      if (input.current.kind === "placeholder") {
        const placeholder = await input.current.complete(
          adoption.preparedCurrent,
          prepared.successorFailure === undefined ? preparationFailure : undefined,
        );
        completed = placeholder.turn;
        completedBlocks = placeholder.blocks;
      } else {
        completed = {
          ...currentTurn,
          status: "complete" as const,
          finishReason: "end_turn" as const,
          completedAt: new Date().toISOString(),
        };
      }
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
          { afterEvents: () => recordEvidence(currentTurn.id) },
        );
        await ack(threadId, drain.ackIds, deliveredBy(currentTurn));
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
              await recordEvidence(next.id);
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
        afterEvents: () => recordEvidence(currentTurn.id),
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
      await ack(threadId, drain.ackIds, deliveredBy(next));
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
      completedBlocks,
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
    const { turn: completed, blocks: completedBlocks } = await input.current.complete(
      prepared.preparedCurrent,
      prepared.currentFailure,
    );
    await endExecution(input.lease);
    return {
      drain,
      next: completed,
      completed,
      completedBlocks,
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

  const commands = createThreadCommands({
    threadLock,
    handBacks: deps.handBacks,
    inbox,
    ack,
    leaseStore,
    appendEvent: (threadId, event) => deps.eventWriter.appendEvent(threadId, event),
  });

  return {
    ...createThreadControls({
      withThreadLock: threadLock.withThreadLock,
      findMessage: inbox.findMessage,
      enqueue,
      // A switch never wakes the chat: it waits for the run something else starts.
      enqueueWithoutWake: inbox.enqueue,
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
      async setWorkDefault(threadId, mode) {
        const thread = await deps.repos.threads.findById(threadId);
        if (thread?.workId)
          await deps.writeModeSwitch.setWorkDefault(thread.workId as WorkId, mode);
      },
      findControlTurn: (id, controlId) => deps.repos.turns.findByControlId(id, controlId),
      answerRunState: inbox.answerRunState,
      acknowledge: (id, controlIds) => ack(id, controlIds),
      hasCompletedReply: (id) => hasCompletedReplyInLineage(deps.repos, id),
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
    retireOrphanedReply: settlement.retireOrphanedReply,
    clearOrphanedTurn: settlement.clearOrphanedTurn,
    settleStaleExecution: settlement.settleStaleExecution,
    releaseExecution: settlement.releaseExecution,
    blockForUsage: settlement.blockForUsage,
    selectPending: inbox.selectPending,
    readPendingProjection: inbox.readPendingProjection,
    pendingMessageThreads: inbox.pendingMessageThreads,
    enqueue: (draft) => threadLock.withThreadLock(draft.threadId, () => enqueue(draft)),
    answerRunState: (threadId) =>
      threadLock.withThreadLock(threadId, () => inbox.answerRunState(threadId)),
    ...commands,
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
        select: (lockHeld) => selectRunStart(lease.threadId, options?.retryOf, lockHeld),
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
    ackWithResponse: settlement.ackWithResponse,
    splitAndContinue: (input) => adopt(input),
    close: async (input) => {
      const threadId = input.lease.threadId;
      const disposition = await threadLock.withThreadLock(threadId, async () => {
        const receipt = await leaseStore.lockReceipt(input.lease);
        const cause = settlement.closeCause(input, receipt);
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
        const completion = await settlement.settleTerminal(
          input.lease,
          input.turnId,
          cause,
          receipt,
        );
        return { kind: "completed" as const, completion };
      });
      if (disposition.kind === "completed") return disposition;

      const boundary = input.continueWith as DeliveryBoundary;
      const adopted = await adopt(boundary);
      if (adopted.split) return { kind: "split", adopted };
      const completion = await settlement.settleClosed(input);
      return { kind: "completed", completion };
    },
  };
}

function sameInboxBatch(left: readonly InboxMessage[], right: readonly InboxMessage[]): boolean {
  return (
    left.length === right.length && left.every((message, index) => message.id === right[index]?.id)
  );
}
