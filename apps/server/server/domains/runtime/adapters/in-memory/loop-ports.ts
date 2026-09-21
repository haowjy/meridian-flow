/**
 * In-memory loop ports for tests and local dev: Map-backed `Inbox` and
 * `RunAuthority` plus a recording `RunStarter`. The authority fake takes an
 * injected clock so lease expiry and renewal are deterministic.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ThreadLeaseState } from "@meridian/contracts/threads";
import {
  DEFAULT_LEASE_TTL_MS,
  type Inbox,
  type InboxMessage,
  type RunAuthority,
  type RunId,
  type RunStarter,
  type ThreadPhase,
} from "../../loop/ports.js";
import type { ThreadLock } from "../../loop/thread-lock.js";

export function createInMemoryInbox(): Inbox {
  const messages: InboxMessage[] = [];
  let nextSeq = 0;
  return {
    async enqueue(draft) {
      const existing = messages.find(
        (message) =>
          message.threadId === draft.threadId && message.idempotencyKey === draft.idempotencyKey,
      );
      if (existing) return existing;
      nextSeq += 1;
      const message: InboxMessage = {
        ...draft,
        id: crypto.randomUUID(),
        seq: nextSeq,
        enqueuedAt: new Date().toISOString(),
        deliveredAt: null,
      };
      messages.push(message);
      return message;
    },

    async claimPending(threadId) {
      return messages
        .filter((message) => message.threadId === threadId && message.deliveredAt === null)
        .sort((left, right) => left.seq - right.seq);
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

    async pendingMessageThreads(limit) {
      const threads: ThreadId[] = [];
      const seen = new Set<ThreadId>();
      for (const message of [...messages].sort((left, right) => left.seq - right.seq)) {
        if (message.intent !== "message" || message.deliveredAt !== null) continue;
        if (seen.has(message.threadId)) continue;
        seen.add(message.threadId);
        threads.push(message.threadId);
        if (threads.length >= limit) break;
      }
      return threads;
    },
  };
}

interface InMemoryLease {
  runId: RunId;
  turnId: TurnId | null;
  holderId: string;
  phase: ThreadPhase;
  cancelRequested: boolean;
  expiresAt: number;
}

export interface InMemoryRunAuthorityOptions {
  /** Stable holder identity for the adapter; a random one is minted when omitted. */
  holderId?: string;
  leaseTtlMs?: number;
  /** Injected clock (ms since epoch) so expiry is deterministic in tests. */
  now?: () => number;
}

export function createInMemoryRunAuthority(
  options: InMemoryRunAuthorityOptions = {},
): RunAuthority {
  const holderId = options.holderId ?? crypto.randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const leases = new Map<ThreadId, InMemoryLease>();

  const liveLease = (threadId: ThreadId): InMemoryLease | null => {
    const lease = leases.get(threadId);
    if (!lease || lease.expiresAt <= now()) return null;
    return lease;
  };

  return {
    async acquire(threadId, runId) {
      if (liveLease(threadId)) return null;
      leases.set(threadId, {
        runId,
        turnId: null,
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

    async bindTurn(lease, turnId) {
      const row = leases.get(lease.threadId);
      if (!row || row.runId !== lease.runId) return;
      row.turnId = turnId;
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

    async cancel(threadId) {
      const row = liveLease(threadId);
      if (row) row.cancelRequested = true;
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
