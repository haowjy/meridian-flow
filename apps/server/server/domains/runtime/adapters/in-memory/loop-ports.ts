/**
 * In-memory loop ports for tests and local dev: Map-backed `DeliveryStore` and
 * `RunClaim` plus a recording `RunStarter`. The authority fake takes an
 * injected clock so lease expiry and renewal are deterministic.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ThreadLeaseState } from "@meridian/contracts/threads";
import {
  DEFAULT_LEASE_TTL_MS,
  type InboxMessage,
  type RunClaim,
  type RunId,
  type RunStarter,
  type ThreadPhase,
} from "../../loop/ports.js";
import type { ThreadLock } from "../../loop/thread-lock.js";
import { createDeliveryAdapter, type DeliveryStore } from "../runtime-delivery.js";

export function createInMemoryInbox(): DeliveryStore {
  const messages: InboxMessage[] = [];
  let nextSeq = 0;
  return {
    async workNoticeTargets() {
      throw new Error("Work notice audience is not configured");
    },
    async canMaterializeWork() {
      return true;
    },
    async pendingWorkThreads(limit, afterThreadId) {
      return [
        ...new Set(
          messages
            .filter((m) => m.body.kind === "work_context_refresh" && !m.deliveredAt)
            .map((m) => m.threadId),
        ),
      ]
        .sort()
        .filter((id) => !afterThreadId || id > afterThreadId)
        .slice(0, limit);
    },
    async enqueue(draft) {
      const existing = messages.find(
        (message) =>
          message.threadId === draft.threadId && message.idempotencyKey === draft.idempotencyKey,
      );
      if (existing) return existing;
      nextSeq += 1;
      const message: InboxMessage = {
        ...draft,
        id: draft.id ?? crypto.randomUUID(),
        seq: nextSeq,
        enqueuedAt: new Date().toISOString(),
        deliveredAt: null,
      };
      messages.push(message);
      return message;
    },

    async selectPending(threadId) {
      return messages
        .filter((message) => message.threadId === threadId && message.deliveredAt === null)
        .sort((left, right) => left.seq - right.seq);
    },

    async readPendingProjection(threadId) {
      return {
        messages: messages
          .filter((message) => message.threadId === threadId && message.deliveredAt === null)
          .sort((left, right) => left.seq - right.seq),
        run: null,
      };
    },

    async ack(threadId, ids) {
      const deliveredAt = new Date().toISOString();
      const targets = new Set(ids);
      for (const message of messages) {
        if (
          message.threadId === threadId &&
          targets.has(message.id) &&
          message.deliveredAt === null
        ) {
          message.deliveredAt = deliveredAt;
        }
      }
    },

    async pendingMessageThreads(limit, afterThreadId) {
      return [
        ...new Set(
          messages
            .filter((message) => message.intent === "message" && message.deliveredAt === null)
            .map((message) => message.threadId),
        ),
      ]
        .sort()
        .filter((threadId) => !afterThreadId || threadId > afterThreadId)
        .slice(0, limit);
    },
  };
}

interface InMemoryLease {
  runId: RunId;
  turnId: TurnId | null;
  messageIds: string[];
  holderId: string;
  phase: ThreadPhase;
  cancelRequested: boolean;
  expiresAt: number;
}

export interface InMemoryRunClaimOptions {
  /** Stable holder identity for the adapter; a random one is minted when omitted. */
  holderId?: string;
  leaseTtlMs?: number;
  /** Injected clock (ms since epoch) so expiry is deterministic in tests. */
  now?: () => number;
}

export function createInMemoryRunClaim(options: InMemoryRunClaimOptions = {}): RunClaim &
  import("../runtime-delivery.js").DeliveryLeaseStore & {
    readDeliveryRun(threadId: ThreadId): import("../../loop/ports.js").InboxProjection["run"];
  } {
  const holderId = options.holderId ?? crypto.randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const leases = new Map<ThreadId, InMemoryLease>();
  const shortClaims = new Set<ThreadId>();

  const liveLease = (threadId: ThreadId): InMemoryLease | null => {
    const lease = leases.get(threadId);
    if (!lease || lease.expiresAt <= now()) return null;
    return lease;
  };

  return {
    readDeliveryRun(threadId) {
      const row = liveLease(threadId);
      return row ? { turnId: row.turnId, messageIds: [...row.messageIds] } : null;
    },
    async withExclusiveThread(threadId, operation) {
      if (shortClaims.has(threadId) || leases.has(threadId)) return null;
      shortClaims.add(threadId);
      try {
        return await operation();
      } finally {
        shortClaims.delete(threadId);
      }
    },
    async startExecution(threadId, runId) {
      if (shortClaims.has(threadId) || leases.has(threadId)) return null;
      leases.set(threadId, {
        runId,
        turnId: null,
        messageIds: [],
        holderId,
        phase: "generating",
        cancelRequested: false,
        expiresAt: now() + leaseTtlMs,
      });
      return { threadId, runId, holderId };
    },

    async renew(lease) {
      const row = leases.get(lease.threadId);
      if (!row || row.runId !== lease.runId) return false;
      row.expiresAt = now() + leaseTtlMs;
      return true;
    },

    async holder(threadId) {
      return liveLease(threadId)?.runId ?? null;
    },

    async publish(lease, phase) {
      const row = leases.get(lease.threadId);
      if (!row || row.runId !== lease.runId) return;
      row.phase = phase;
    },

    async bindTurn(lease, turnId, messageIds) {
      const row = leases.get(lease.threadId);
      if (!row || row.runId !== lease.runId || row.cancelRequested)
        throw new Error("Cannot bind assistant turn after losing live run lease");
      row.turnId = turnId;
      row.messageIds = [...messageIds];
    },

    async setAdoptedMessageIds(lease, messageIds) {
      const row = leases.get(lease.threadId);
      if (!row || row.runId !== lease.runId || !row.turnId) return false;
      row.messageIds = [...messageIds];
      return true;
    },

    async clearReceipt(lease, expectedIds) {
      const row = leases.get(lease.threadId);
      if (
        !row ||
        row.runId !== lease.runId ||
        row.holderId !== lease.holderId ||
        row.messageIds.length !== expectedIds.length ||
        row.messageIds.some((id, i) => id !== expectedIds[i])
      )
        return false;
      row.messageIds = [];
      return true;
    },
    async lockReceipt(lease) {
      const row = leases.get(lease.threadId);
      return row?.runId === lease.runId
        ? { ids: [...row.messageIds], cancelRequested: row.cancelRequested }
        : null;
    },

    async read(threadId) {
      const row = liveLease(threadId);
      if (!row) return { kind: "asleep" };
      return { kind: "awake", phase: row.phase, cancelRequested: row.cancelRequested };
    },

    async readMany(threadIds) {
      const states = new Map<ThreadId, ThreadLeaseState>();
      for (const threadId of threadIds) {
        const row = liveLease(threadId);
        if (!row) continue;
        states.set(threadId, {
          status: { kind: "awake", phase: row.phase, cancelRequested: row.cancelRequested },
          runningTurnId: row.turnId,
        });
      }
      return states;
    },

    async readRunningTurnId(threadId) {
      return liveLease(threadId)?.turnId ?? null;
    },

    async cancelExecution(threadId, turnId) {
      const row = liveLease(threadId);
      if (!row || row.turnId !== turnId) return false;
      row.cancelRequested = true;
      return true;
    },

    async release(lease) {
      const row = leases.get(lease.threadId);
      if (row && row.runId === lease.runId) leases.delete(lease.threadId);
    },
  };
}

export interface InMemoryRunStarter extends RunStarter {
  readonly started: ThreadId[];
}

export function createInMemoryRunStarter(): InMemoryRunStarter {
  const started: ThreadId[] = [];
  return {
    started,
    async start(threadId) {
      started.push(threadId);
    },
  };
}

export function createInMemoryThreadLock(): ThreadLock {
  const chains = new Map<ThreadId, Promise<unknown>>();
  return {
    withThreadLock<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T> {
      const previous = chains.get(threadId) ?? Promise.resolve();
      const result = previous.then(operation, operation);
      chains.set(
        threadId,
        result.then(
          () => undefined,
          () => undefined,
        ),
      );
      return result;
    },
  };
}

/** Bind the memory delivery store and claim to the same receipt owner. */
export function createInMemoryRuntimeDelivery(
  deps: Omit<Parameters<typeof createDeliveryAdapter>[0], "leaseStore" | "runClaim"> & {
    runClaim: ReturnType<typeof createInMemoryRunClaim>;
  },
) {
  return createDeliveryAdapter({
    ...deps,
    leaseStore: deps.runClaim,
    inbox: {
      ...deps.inbox,
      async readPendingProjection(threadId) {
        return {
          messages: await deps.inbox.selectPending(threadId),
          run: deps.runClaim.readDeliveryRun(threadId),
        };
      },
    },
  });
}
