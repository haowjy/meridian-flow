/**
 * In-memory loop ports for tests and local dev: Map-backed `DeliveryStore` and
 * `RunClaim` plus a recording `RunStarter`. The authority fake takes an
 * injected clock so lease expiry and renewal are deterministic.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { CurrentToolCall, ThreadLeaseState } from "@meridian/contracts/threads";
import {
  DEFAULT_LEASE_TTL_MS,
  type ExecutionId,
  type InboxMessage,
  type RunClaim,
  type RunStarter,
  type ThreadPhase,
} from "../../loop/ports.js";
import { projectRunState } from "../../loop/run-state.js";
import type { ThreadLock } from "../../loop/thread-lock.js";
import { createDeliveryAdapter, type DeliveryStore } from "../runtime-delivery.js";

export function createInMemoryInbox(): DeliveryStore {
  const blocked = new Map<ThreadId, "credits_exhausted">();
  const messages: InboxMessage[] = [];
  let nextSeq = 0;
  return {
    // The in-memory adapter publishes no run-state record.
    markRunStateChanged() {},
    async publishRunState() {
      return null;
    },
    async answerRunState() {
      throw new Error(
        "The in-memory inbox answers run state through createInMemoryRuntimeDelivery",
      );
    },
    async setBlockedReason(threadId, reason) {
      if (reason) blocked.set(threadId, reason);
      else blocked.delete(threadId);
    },
    async workNoticeTargets(_workId) {
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
    async findMessage(id) {
      return messages.find((row) => row.id === id) ?? null;
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
      const reason = blocked.get(threadId);
      return {
        ...(reason ? { blocked: { reason } } : {}),
        messages: messages
          .filter((message) => message.threadId === threadId && message.deliveredAt === null)
          .sort((left, right) => left.seq - right.seq),
        run: null,
      };
    },

    async ack(threadId, ids) {
      const deliveredAt = new Date().toISOString();
      const targets = new Set(ids);
      const delivered: string[] = [];
      for (const message of messages) {
        if (
          message.threadId === threadId &&
          targets.has(message.id) &&
          message.deliveredAt === null
        ) {
          message.deliveredAt = deliveredAt;
          if (message.intent === "message") delivered.push(message.id);
        }
      }
      return delivered;
    },

    async pendingMessageThreads(limit, afterThreadId) {
      return [
        ...new Set(
          messages
            .filter(
              (message) =>
                (message.intent === "message" || message.intent === "control") &&
                message.deliveredAt === null,
            )
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
  executionId: ExecutionId;
  turnId: TurnId | null;
  boundTurnIds: Set<TurnId>;
  /** Some turn records this execution (bindTurn runs in each reservation). */
  represented: boolean;
  messageIds: string[];
  holderId: string;
  phase: ThreadPhase;
  cancelRequested: boolean;
  currentTool: CurrentToolCall | null;
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
  // The execution claim, apart from its row: abandon unlocks and keeps the row.
  const locked = new Set<ThreadId>();

  const liveLease = (threadId: ThreadId): InMemoryLease | null => {
    const lease = leases.get(threadId);
    if (!lease || lease.expiresAt <= now()) return null;
    return lease;
  };

  async function hold(threadId: ThreadId) {
    if (shortClaims.has(threadId) || locked.has(threadId)) return null;
    shortClaims.add(threadId);
    let held = true;
    return {
      async release() {
        if (!held) return;
        held = false;
        shortClaims.delete(threadId);
      },
      onLost() {
        return () => undefined;
      },
    };
  }

  return {
    readDeliveryRun(threadId) {
      const row = liveLease(threadId);
      return row ? { turnId: row.turnId, messageIds: [...row.messageIds] } : null;
    },
    hold,
    async withExclusiveThread(threadId, operation) {
      const claim = await hold(threadId);
      if (!claim) return null;
      try {
        return await operation();
      } finally {
        await claim.release();
      }
    },
    async startExecution(threadId, executionId, settle) {
      if (shortClaims.has(threadId) || locked.has(threadId)) return null;
      locked.add(threadId);
      try {
        await settle();
        if (leases.has(threadId)) throw new Error("Stale execution row survived settlement");
      } catch (error) {
        locked.delete(threadId);
        throw error;
      }
      leases.set(threadId, {
        executionId,
        turnId: null,
        boundTurnIds: new Set(),
        represented: false,
        messageIds: [],
        holderId,
        phase: "generating",
        cancelRequested: false,
        currentTool: null,
        expiresAt: now() + leaseTtlMs,
      });
      return { threadId, executionId, holderId };
    },

    async renew(lease) {
      const row = leases.get(lease.threadId);
      if (!row || row.executionId !== lease.executionId) return false;
      row.expiresAt = now() + leaseTtlMs;
      return true;
    },

    async holder(threadId) {
      return liveLease(threadId)?.executionId ?? null;
    },

    async publish(lease, phase) {
      const row = leases.get(lease.threadId);
      if (!row || row.executionId !== lease.executionId) return;
      row.phase = phase;
    },

    async setCurrentTool(lease, currentTool) {
      const row = liveLease(lease.threadId);
      if (!row || row.executionId !== lease.executionId || row.holderId !== lease.holderId)
        return false;
      if (JSON.stringify(row.currentTool) === JSON.stringify(currentTool)) return false;
      row.currentTool = currentTool;
      return true;
    },

    async bindTurn(lease, turnId, messageIds) {
      const row = leases.get(lease.threadId);
      if (!row || row.executionId !== lease.executionId || row.cancelRequested)
        throw new Error("Cannot bind assistant turn after losing live run lease");
      row.turnId = turnId;
      row.boundTurnIds.add(turnId);
      row.represented = true;
      row.messageIds = [...messageIds];
    },

    async setAdoptedMessageIds(lease, messageIds) {
      const row = leases.get(lease.threadId);
      if (!row || row.executionId !== lease.executionId || !row.turnId) return false;
      row.messageIds = [...messageIds];
      return true;
    },

    async clearReceipt(lease, expectedIds) {
      const row = leases.get(lease.threadId);
      if (
        !row ||
        row.executionId !== lease.executionId ||
        row.holderId !== lease.holderId ||
        row.messageIds.length !== expectedIds.length ||
        row.messageIds.some((id, i) => id !== expectedIds[i])
      )
        return false;
      row.messageIds = [];
      return true;
    },
    async clearOrphanedReceipt(threadId, turnId, expectedIds) {
      const row = leases.get(threadId);
      if (
        !row ||
        row.turnId !== turnId ||
        row.messageIds.length !== expectedIds.length ||
        row.messageIds.some((id, i) => id !== expectedIds[i])
      )
        return false;
      row.turnId = null;
      row.boundTurnIds.clear();
      row.messageIds = [];
      return true;
    },
    async cancelThreadReceipt(threadId, turnId) {
      const row = leases.get(threadId);
      if (!row || row.turnId !== turnId) return false;
      row.cancelRequested = true;
      return true;
    },
    async lockThreadReceipt(threadId) {
      const row = leases.get(threadId);
      return row
        ? {
            ids: [...row.messageIds],
            turnId: row.turnId,
            lease: { threadId, executionId: row.executionId, holderId: row.holderId },
          }
        : null;
    },
    async lockReceipt(lease) {
      const row = leases.get(lease.threadId);
      return row?.executionId === lease.executionId
        ? { ids: [...row.messageIds], cancelRequested: row.cancelRequested }
        : null;
    },

    async read(threadId) {
      const row = liveLease(threadId);
      if (!row) return { kind: "asleep" };
      return { kind: "awake", phase: row.phase, cancelRequested: row.cancelRequested };
    },

    async readOwned(lease) {
      const row = leases.get(lease.threadId);
      return row?.executionId === lease.executionId && row.holderId === lease.holderId
        ? { cancelRequested: row.cancelRequested }
        : null;
    },

    async readMany(threadIds) {
      const states = new Map<ThreadId, ThreadLeaseState>();
      for (const threadId of threadIds) {
        const row = liveLease(threadId);
        if (!row) continue;
        states.set(threadId, {
          status: { kind: "awake", phase: row.phase, cancelRequested: row.cancelRequested },
          runningTurnId: row.turnId,
          currentTool: row.currentTool,
        });
      }
      return states;
    },

    async readOpenExecutionId(threadId) {
      const row = leases.get(threadId);
      return row?.represented ? row.executionId : null;
    },

    async listExpiredExecutions(limit, afterThreadId) {
      return [...leases]
        .filter(([threadId, row]) => row.expiresAt <= now() && !locked.has(threadId))
        .map(([threadId]) => threadId)
        .sort()
        .filter((threadId) => !afterThreadId || threadId > afterThreadId)
        .slice(0, limit);
    },

    async lockStaleExecution(threadId) {
      const row = leases.get(threadId);
      return row ? { executionId: row.executionId } : null;
    },

    async deleteStaleExecution(threadId, executionId) {
      if (leases.get(threadId)?.executionId !== executionId) return false;
      leases.delete(threadId);
      return true;
    },

    async abandon(lease) {
      const row = leases.get(lease.threadId);
      if (row?.executionId === lease.executionId && row.holderId === lease.holderId) {
        row.expiresAt = now();
        locked.delete(lease.threadId);
      }
    },

    async readRunningTurnId(threadId) {
      return liveLease(threadId)?.turnId ?? null;
    },

    async cancelExecution(threadId, turnId) {
      const row = liveLease(threadId);
      if (!row?.boundTurnIds.has(turnId)) return false;
      row.cancelRequested = true;
      return true;
    },

    async release(lease) {
      const row = leases.get(lease.threadId);
      if (!row || row.executionId !== lease.executionId) return false;
      leases.delete(lease.threadId);
      locked.delete(lease.threadId);
      return true;
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
    /** The thread's journal head as the socket numbers its frames: the in-memory record's version. */
    headSeq(threadId: ThreadId): Promise<bigint>;
  },
) {
  return createDeliveryAdapter({
    ...deps,
    leaseStore: deps.runClaim,
    inbox: {
      ...deps.inbox,
      // In memory the record is derived on demand at the journal head; nothing is published.
      async answerRunState(threadId) {
        const projection = await deps.inbox.readPendingProjection(threadId);
        const run = deps.runClaim.readDeliveryRun(threadId);
        const executionId = await deps.runClaim.readOpenExecutionId(threadId);
        const thread = await deps.repos.threads.findById(threadId);
        const body = projectRunState({
          messages: projection.messages,
          lease: executionId
            ? { executionId, turnId: run?.turnId ?? null, adoptedMessageIds: run?.messageIds ?? [] }
            : null,
          executionOpen: executionId !== null,
          sentThrough: Math.max(
            0,
            ...projection.messages
              .filter((m) => m.intent === "message" && m.provenance.kind === "writer")
              .map((m) => m.seq),
          ),
          mode: thread?.aiWriteMode ?? "direct",
          blockedReason: projection.blocked?.reason ?? null,
        });
        return { ...body, version: (await deps.headSeq(threadId)).toString() };
      },
      async readPendingProjection(threadId) {
        return {
          ...(await deps.inbox.readPendingProjection(threadId)),
          run: deps.runClaim.readDeliveryRun(threadId),
        };
      },
    },
  });
}
