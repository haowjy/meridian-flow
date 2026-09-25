/** Shared delivery transitions. Concrete adapters supply one compatible transaction/store bundle. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { NoticePort } from "../../notices/index.js";
import { finalizeExecution } from "../loop/execution-finalizer.js";
import { drainInbox } from "../loop/inbox-context.js";
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
    runClaim: Pick<RunClaim, "release">;
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
  async function adopt(input: DeliveryBoundary, batch: InboxMessage[]): Promise<AdoptedBatch> {
    const { lease, currentTurn } = input;
    const threadId = lease.threadId;
    const split = batch.some(
      (message) => message.intent === "message" && !input.knownTurnIds.has(message.id),
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
      notices: deps.notices,
      threadId,
      batch,
      messages: [],
    });
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
    refreshPending: (threadId) =>
      threadLock.withThreadLock(threadId, () => appendPending(threadId)),
    selectPending: inbox.selectPending,
    readPendingProjection: inbox.readPendingProjection,
    pendingMessageThreads: inbox.pendingMessageThreads,
    enqueue: (draft) => threadLock.withThreadLock(draft.threadId, () => enqueue(draft)),
    withThreadLock: (threadId, operation) =>
      threadLock.withThreadLock(threadId, () =>
        operation({
          enqueue(draft) {
            if (draft.threadId !== threadId)
              throw new Error("Scoped delivery cannot enqueue another thread");
            return enqueue(draft);
          },
        }),
      ),
    adoptBatch: (lease, prepare) =>
      threadLock.withThreadLock(lease.threadId, async () => {
        const prepared = await prepare(await inbox.selectPending(lease.threadId));
        await leaseStore.bindTurn(lease, prepared.turnId, prepared.messageIds);
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
          if (batch.some((message) => message.intent === "message"))
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
