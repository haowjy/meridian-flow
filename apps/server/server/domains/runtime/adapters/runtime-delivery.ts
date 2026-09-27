/** Shared delivery transitions. Concrete adapters supply one compatible transaction/store bundle. */
import type { ProjectId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { NoticePort } from "../../notices/index.js";
import { nextTurnPosition } from "../../threads/order-turns.js";
import { finalizeExecution } from "../loop/execution-finalizer.js";
import { drainInbox, planMessageTurns } from "../loop/inbox-context.js";
import { createLocalTurn } from "../loop/local-turn.js";
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
import type { AdoptedBatch, DeliveryBoundary, RuntimeDelivery } from "../loop/runtime-delivery.js";
import type { ThreadLock } from "../loop/thread-lock.js";
import { ImageAssetResolutionError } from "../ports/image-asset.js";

/** Adapter-private storage primitives; never injected into the model loop or producers. */
export interface DeliveryStore extends InboxReader {
  workNoticeTargets(projectId: ProjectId): Promise<ThreadId[]>;
  canMaterializeWork(threadId: ThreadId): Promise<boolean>;
  pendingWorkThreads(limit: number, afterThreadId?: ThreadId): Promise<ThreadId[]>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  ack(threadId: ThreadId, ids: string[]): Promise<void>;
}

export interface DeliveryLeaseStore {
  bindTurn(lease: Lease, turnId: TurnId, ids: readonly string[]): Promise<void>;
  setAdoptedMessageIds(lease: Lease, ids: readonly string[]): Promise<boolean>;
  clearReceipt(lease: Lease, expectedIds: readonly string[]): Promise<boolean>;
  lockReceipt(lease: Lease): Promise<{ ids: string[]; cancelRequested: boolean } | null>;
}

export function createDeliveryAdapter(
  deps: PersistenceDeps & {
    repos: import("../../threads/index.js").ThreadRepositories;
    inbox: DeliveryStore;
    leaseStore: DeliveryLeaseStore;
    runClaim: Pick<RunClaim, "release" | "withExclusiveThread">;
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
  const enqueue = async (draft: MessageDraft) => {
    const message = await inbox.enqueue(draft);
    await appendPending(draft.threadId);
    if (draft.intent === "message")
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
    const work = await workBatch(threadId, await inbox.selectPending(threadId));
    const turns = await Promise.all(
      work.batch.map((message) => deps.repos.turns.findById(message.id)),
    );
    const leaf = (await deps.repos.threads.findById(threadId))?.activeLeafTurnId ?? null;
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
  type PreparedAdoption = {
    batch: InboxMessage[];
    work: Awaited<ReturnType<typeof workBatch>>;
    committedWorkIds: string[];
    expectedLeaf: TurnId | null;
    expectedLeafPosition: number | null;
    drain: Awaited<ReturnType<typeof drainInbox>>;
    prepared: Awaited<ReturnType<DeliveryBoundary["prepareNextContext"]>>;
    split: boolean;
  };

  async function prepareAdoption(
    input: DeliveryBoundary,
    selectedBatch: InboxMessage[],
  ): Promise<PreparedAdoption> {
    const { lease } = input;
    const work = await workBatch(lease.threadId, selectedBatch);
    const batch = work.batch;
    const threadId = lease.threadId;
    // Writer enqueue can have persisted and acked an earlier Work prefix while
    // this run's provider request was in flight. Adopt that committed history too.
    const committed: InboxMessage[] = [];
    const committedWorkIds: string[] = [];
    const thread = await deps.repos.threads.findById(threadId);
    const expectedLeaf = (thread?.activeLeafTurnId ??
      input.currentTurn.id ??
      null) as TurnId | null;
    const expectedLeafTurn = expectedLeaf ? await deps.repos.turns.findById(expectedLeaf) : null;
    if (expectedLeaf && !expectedLeafTurn) throw new Error(`Missing causal turn: ${expectedLeaf}`);
    let leaf: TurnId | null = expectedLeaf;
    while (leaf && !input.knownTurnIds.has(leaf)) {
      const turn = await deps.repos.turns.findById(leaf);
      if (!turn) throw new Error(`Missing causal turn: ${leaf}`);
      const message = batch.find((entry) => entry.id === turn.id);
      if (message) committed.unshift(message);
      else if ((turn.metadata as { kind?: string } | null)?.kind === "system_update") {
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
    const notices = await deps.notices.drainForModelContext(threadId);
    const split =
      !!work.workContext ||
      committedWorkIds.length > 0 ||
      notices.length > 0 ||
      orderedBatch.some(
        (message) =>
          (message.intent === "message" && !input.knownTurnIds.has(message.id)) ||
          (message.intent === "notice" && message.body.kind !== "work_context_refresh"),
      );
    const drain = await drainInbox({
      ...input,
      persistence: deps,
      notices,
      threadId,
      batch: orderedBatch,
      workContext: work.workContext,
    });
    let prepared: Awaited<ReturnType<DeliveryBoundary["prepareNextContext"]>>;
    try {
      prepared = await input.prepareNextContext(drain);
    } catch (error) {
      if (error instanceof ImageAssetResolutionError && drain.ackIds.length > 0) {
        const recorded = await threadLock.withThreadLock(threadId, () =>
          leaseStore.setAdoptedMessageIds(lease, drain.ackIds),
        );
        if (!recorded) {
          throw new Error(
            "Cannot acknowledge failed context preparation after losing live run lease",
            {
              cause: error,
            },
          );
        }
      }
      throw error;
    }
    return {
      batch: orderedBatch,
      work,
      committedWorkIds,
      expectedLeaf,
      expectedLeafPosition: expectedLeafTurn?.position ?? null,
      drain,
      prepared,
      split: split || drain.events.length > 0 || prepared.requiresSplit,
    };
  }

  async function commitAdoption(
    input: DeliveryBoundary,
    adoption: PreparedAdoption,
  ): Promise<AdoptedBatch> {
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
    } = adoption;
    const turns = [...drain.turns, ...prepared.turns];
    const blocks = [...drain.blocks, ...prepared.blocks];
    const events = [...drain.events, ...prepared.events];
    let next = currentTurn;

    if (split) {
      const completed = {
        ...currentTurn,
        status: "complete" as const,
        finishReason: "end_turn" as const,
        completedAt: new Date().toISOString(),
      };
      const leaf = turns.at(-1)?.id ?? expectedLeaf ?? currentTurn.id;
      next = createLocalTurn({
        threadId,
        position: nextTurnPosition(
          turns.at(-1) ??
            (expectedLeafPosition === null ? null : { position: expectedLeafPosition }),
        ),
        prevTurnId: leaf,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
        writeMode: currentTurn.writeMode,
      });
      await persistAndAppendTurnStartEvents(
        deps,
        threadId,
        expectedLeaf,
        async () => ({
          result: undefined,
          events: [
            { type: "turn.completed", turn: completed },
            ...events,
            { type: "turn.created", turn: next },
          ],
        }),
        { afterEvents: () => leaseStore.bindTurn(lease, next.id, drain.ackIds) },
      );
      await deps.repos.threads.updateCost(threadId, "0", 1);
    } else if (events.length > 0) {
      await persistAndAppendEvents(deps, threadId, async () => ({ result: undefined, events }));
    }

    await inbox.ack(threadId, work.ids);
    drain.ackIds = drain.ackIds.filter(
      (id) => !work.ids.includes(id) && !committedWorkIds.includes(id),
    );
    if (
      !split &&
      batch.length > 0 &&
      !(await leaseStore.setAdoptedMessageIds(lease, drain.ackIds))
    ) {
      throw new Error("Cannot adopt inbox batch after losing live run lease");
    }
    if (batch.length > 0) await appendPending(threadId);
    drain.turns = turns;
    drain.blocks = blocks;
    return { drain, next, split };
  }

  async function adopt(input: DeliveryBoundary, batch: InboxMessage[]): Promise<AdoptedBatch> {
    const prepared = await prepareAdoption(input, batch);
    return threadLock.withThreadLock(input.lease.threadId, () => commitAdoption(input, prepared));
  }

  return {
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
    selectPending: inbox.selectPending,
    readPendingProjection: inbox.readPendingProjection,
    pendingMessageThreads: inbox.pendingMessageThreads,
    enqueue: (draft) => threadLock.withThreadLock(draft.threadId, () => enqueue(draft)),
    withThreadLock: (threadId, operation) =>
      threadLock.withThreadLock(threadId, () =>
        operation({
          materializePrefix: () => materializePrefix(threadId),
          enqueue(draft) {
            if (draft.threadId !== threadId)
              throw new Error("Scoped delivery cannot enqueue another thread");
            return enqueue(draft);
          },
        }),
      ),
    adoptBatch: async (lease, prepare) => {
      const pending = await threadLock.withThreadLock(lease.threadId, () =>
        inbox.selectPending(lease.threadId),
      );
      const work = await workBatch(lease.threadId, pending);
      const prepared = await prepare(work.batch, work.workContext);
      return threadLock.withThreadLock(lease.threadId, async () => {
        await prepared.persist?.();
        await inbox.ack(lease.threadId, work.ids);
        await leaseStore.bindTurn(
          lease,
          prepared.turnId,
          prepared.messageIds.filter((id) => !work.ids.includes(id)),
        );
        await appendPending(lease.threadId);
        return prepared.value;
      });
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
    splitAndContinue: async (input) => {
      const batch = await threadLock.withThreadLock(input.lease.threadId, () =>
        inbox.selectPending(input.lease.threadId),
      );
      return adopt(input, batch);
    },
    close: async (input) => {
      const threadId = input.lease.threadId;
      const disposition = await threadLock.withThreadLock(threadId, async () => {
        // Serialize the terminal decision with remote cancellation, not only the loop's cached flag.
        const receipt = await leaseStore.lockReceipt(input.lease);
        const cause = receipt?.cancelRequested
          ? { kind: "cancelled" as const, reason: "cancelled" }
          : input.cause;
        if (input.continueWith && cause.kind === "success") {
          const batch = await inbox.selectPending(threadId);
          if (
            batch.some((message) => message.intent === "message") ||
            (batch.some((message) => message.body.kind === "work_context_refresh") &&
              (await inbox.canMaterializeWork(threadId)))
          ) {
            return { kind: "prepare_split" as const, batch };
          }
        }
        const completion = await finalizeExecution(deps, {
          threadId,
          assistantTurnId: input.assistantTurnId,
          cause,
        });
        if (
          completion.turn.status === "cancelled" ||
          (cause.kind === "failed" && cause.acknowledgeInbox)
        ) {
          await inbox.ack(threadId, receipt?.ids ?? []);
        }
        await deps.runClaim.release(input.lease);
        await appendPending(threadId);
        return { kind: "completed" as const, completion };
      });
      if (disposition.kind === "completed") return disposition;

      const prepared = await prepareAdoption(
        input.continueWith as DeliveryBoundary,
        disposition.batch,
      );
      return threadLock.withThreadLock(threadId, async () => {
        const receipt = await leaseStore.lockReceipt(input.lease);
        if (receipt?.cancelRequested) {
          const completion = await finalizeExecution(deps, {
            threadId,
            assistantTurnId: input.assistantTurnId,
            cause: { kind: "cancelled", reason: "cancelled" },
          });
          await inbox.ack(threadId, receipt.ids);
          await deps.runClaim.release(input.lease);
          await appendPending(threadId);
          return { kind: "completed" as const, completion };
        }
        const adopted = await commitAdoption(input.continueWith as DeliveryBoundary, prepared);
        return { kind: "split" as const, adopted };
      });
    },
  };
}
