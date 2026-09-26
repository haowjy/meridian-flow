/** Shared delivery transitions. Concrete adapters supply one compatible transaction/store bundle. */
import type { ProjectId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { NoticePort } from "../../notices/index.js";
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
    const plan = planMessageTurns({
      threadId,
      batch: work.batch,
      workContext: work.workContext,
      prevTurnId: leaf,
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
  async function adopt(input: DeliveryBoundary, batch: InboxMessage[]): Promise<AdoptedBatch> {
    const { lease, currentTurn } = input;
    const work = await workBatch(lease.threadId, batch);
    batch = work.batch;
    const threadId = lease.threadId;
    // Writer enqueue can have persisted and acked an earlier Work prefix while
    // this run's provider request was in flight. Adopt that committed history too.
    const committed: InboxMessage[] = [];
    const committedWorkIds: string[] = [];
    let leaf = (await deps.repos.threads.findById(threadId))?.activeLeafTurnId;
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
      leaf = turn.prevTurnId;
    }
    const committedIds = new Set(committed.map((message) => message.id));
    batch = [...committed, ...batch.filter((message) => !committedIds.has(message.id))];
    // Destructive: drained at most once per adopt, and folded into the same
    // split/persist decision as the batch so it lands in the same durable
    // `system_update` turn `drainInbox` builds below (never spliced request-only).
    const notices = await deps.notices.drainForModelContext(threadId);
    const split =
      !!work.workContext ||
      committedWorkIds.length > 0 ||
      notices.length > 0 ||
      batch.some(
        (message) =>
          (message.intent === "message" && !input.knownTurnIds.has(message.id)) ||
          (message.intent === "notice" && message.body.kind !== "work_context_refresh"),
      );
    if (split) {
      const completed = {
        ...currentTurn,
        status: "complete" as const,
        finishReason: "end_turn" as const,
        completedAt: new Date().toISOString(),
      };
      await persistAndAppendEvents(deps, threadId, async () => ({
        result: completed,
        events: [{ type: "turn.completed", turn: completed }],
      }));
      await deps.repos.threads.updateCost(threadId, "0", 1);
    }
    const drain = await drainInbox({
      ...input,
      persistence: deps,
      notices,
      threadId,
      batch,
      workContext: work.workContext,
    });
    await inbox.ack(threadId, work.ids);
    drain.ackIds = drain.ackIds.filter(
      (id) => !work.ids.includes(id) && !committedWorkIds.includes(id),
    );
    let next = currentTurn;
    if (split) {
      const leaf =
        (await deps.repos.threads.findById(threadId))?.activeLeafTurnId ??
        drain.turns.at(-1)?.id ??
        currentTurn.id;
      next = createLocalTurn({
        threadId,
        prevTurnId: leaf,
        role: "assistant",
        status: "streaming",
        writeMode: currentTurn.writeMode,
      });
      await persistAndAppendTurnStartEvents(
        deps,
        threadId,
        leaf,
        async () => ({ result: next, events: [{ type: "turn.created", turn: next }] }),
        { afterEvents: () => leaseStore.bindTurn(lease, next.id, drain.ackIds) },
      );
    } else if (batch.length > 0 && !(await leaseStore.setAdoptedMessageIds(lease, drain.ackIds))) {
      throw new Error("Cannot adopt inbox batch after losing live run lease");
    }
    if (batch.length > 0) await appendPending(threadId);
    return { drain, next, split };
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
    adoptBatch: (lease, prepare) =>
      threadLock.withThreadLock(lease.threadId, async () => {
        const work = await workBatch(lease.threadId, await inbox.selectPending(lease.threadId));
        const prepared = await prepare(work.batch, work.workContext);
        await inbox.ack(lease.threadId, work.ids);
        await leaseStore.bindTurn(
          lease,
          prepared.turnId,
          prepared.messageIds.filter((id) => !work.ids.includes(id)),
        );
        await appendPending(lease.threadId);
        return prepared.value;
      }),
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
    splitAndContinue: (input) =>
      threadLock.withThreadLock(input.lease.threadId, async () =>
        adopt(input, await inbox.selectPending(input.lease.threadId)),
      ),
    close: (input) =>
      threadLock.withThreadLock(input.lease.threadId, async () => {
        const threadId = input.lease.threadId;
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
          )
            return { kind: "split", adopted: await adopt(input.continueWith, batch) };
        }
        const completion = await finalizeExecution(deps, {
          threadId,
          assistantTurnId: input.assistantTurnId,
          cause,
        });
        if (completion.turn.status === "cancelled") await inbox.ack(threadId, receipt?.ids ?? []);
        await deps.runClaim.release(input.lease);
        await appendPending(threadId);
        return { kind: "completed", completion };
      }),
  };
}
