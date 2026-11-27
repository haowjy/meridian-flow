import type { ThreadId } from "@meridian/contracts/runtime";
import type { CurrentToolCall, ThreadLeaseState, ThreadStatus } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import * as schema from "@meridian/database/schema";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import {
  DEFAULT_LEASE_TTL_MS,
  type ExecutionId,
  type RunClaim,
  type ThreadPhase,
} from "../loop/ports.js";
import { markRunStateChanged } from "./drizzle-run-state.js";
import { createDrizzleSessionLock, type SessionLockClaim } from "./drizzle-session-lock.js";

const DB_NOW = sql`clock_timestamp()`;

export interface DrizzleRunClaimOptions {
  holderId?: string;
  leaseTtlMs?: number;
}

export function createDrizzleRunClaim(
  db: Database,
  options: DrizzleRunClaimOptions = {},
): RunClaim {
  const lock = createDrizzleSessionLock(db, 81n);
  const holderId = options.holderId ?? crypto.randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const held = new Map<
    ThreadId,
    { executionId: ExecutionId; holderId: string; claim: SessionLockClaim }
  >();

  const nextExpiry = () => new Date(Date.now() + leaseTtlMs);
  const db_ = () => currentDrizzleDb(db);

  const leaseWasVisible = async (
    released: { threadId: ThreadId; executionId: string },
    row: { turnId: string | null; adoptedMessageIds: string[] },
  ) => {
    if (row.turnId !== null || row.adoptedMessageIds.length > 0) return true;
    const [carrier] = await db_()
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.threadId, released.threadId),
          sql`${schema.turns.executionId}::text = ${released.executionId}`,
        ),
      )
      .limit(1);
    return carrier !== undefined;
  };

  const liveLeaseWhere = (threadId: ThreadId) =>
    and(
      eq(schema.threadRunLeases.threadId, threadId),
      gt(schema.threadRunLeases.expiresAt, new Date()),
    );

  const ownedRow = (lease: { threadId: ThreadId; executionId: string; holderId: string }) =>
    and(
      eq(schema.threadRunLeases.threadId, lease.threadId),
      eq(schema.threadRunLeases.executionId, lease.executionId),
      eq(schema.threadRunLeases.holderId, lease.holderId),
    );

  const hold = (threadId: ThreadId) => lock.tryAcquire(`meridian:thread-run:${threadId}`);

  const toThreadStatus = (row: { phase: string; cancelRequested: boolean }): ThreadStatus => ({
    kind: "awake",
    phase: row.phase as ThreadPhase,
    cancelRequested: row.cancelRequested,
  });

  const selectLiveLease = () =>
    db_()
      .select({
        threadId: schema.threadRunLeases.threadId,
        phase: schema.threadRunLeases.phase,
        cancelRequested: schema.threadRunLeases.cancelRequested,
        turnId: schema.threadRunLeases.turnId,
        currentTool: schema.threadRunLeases.currentTool,
      })
      .from(schema.threadRunLeases);

  return {
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
      const claim = await hold(threadId);
      if (!claim) return null;
      try {
        await settle();
        await db_().insert(schema.threadRunLeases).values({
          threadId,
          executionId,
          turnId: null,
          boundTurnIds: [],
          adoptedMessageIds: [],
          holderId,
          phase: "generating",
          cancelRequested: false,
          currentTool: null,
          acquiredAt: DB_NOW,
          renewedAt: new Date(),
          expiresAt: nextExpiry(),
        });
      } catch (cause) {
        await claim.release();
        throw cause;
      }
      held.set(threadId, { executionId, holderId, claim });
      return { threadId, executionId, holderId };
    },

    async renew(lease) {
      const updated = await db_()
        .update(schema.threadRunLeases)
        .set({ renewedAt: new Date(), expiresAt: nextExpiry() })
        .where(
          and(
            eq(schema.threadRunLeases.threadId, lease.threadId),
            eq(schema.threadRunLeases.executionId, lease.executionId),
            eq(schema.threadRunLeases.holderId, lease.holderId),
          ),
        )
        .returning({ threadId: schema.threadRunLeases.threadId });
      return updated.length > 0;
    },

    async holder(threadId) {
      const [row] = await db_()
        .select({ executionId: schema.threadRunLeases.executionId })
        .from(schema.threadRunLeases)
        .where(liveLeaseWhere(threadId))
        .limit(1);
      return row?.executionId ?? null;
    },

    async publish(lease, phase) {
      await db_()
        .update(schema.threadRunLeases)
        .set({ phase })
        .where(
          and(
            eq(schema.threadRunLeases.threadId, lease.threadId),
            eq(schema.threadRunLeases.executionId, lease.executionId),
            eq(schema.threadRunLeases.holderId, lease.holderId),
          ),
        );
    },

    async setCurrentTool(lease, currentTool: CurrentToolCall) {
      const rows = await db_()
        .update(schema.threadRunLeases)
        .set({ currentTool })
        .where(
          and(
            eq(schema.threadRunLeases.threadId, lease.threadId),
            eq(schema.threadRunLeases.executionId, lease.executionId),
            eq(schema.threadRunLeases.holderId, lease.holderId),
            gt(schema.threadRunLeases.expiresAt, new Date()),
            sql`${schema.threadRunLeases.currentTool} IS DISTINCT FROM ${JSON.stringify(currentTool)}::jsonb`,
          ),
        )
        .returning({ threadId: schema.threadRunLeases.threadId });
      return rows.length > 0;
    },

    async read(threadId) {
      const [row] = await selectLiveLease().where(liveLeaseWhere(threadId)).limit(1);
      if (!row) return { kind: "asleep" };
      return toThreadStatus(row);
    },

    async readOwned(lease) {
      const [row] = await selectLiveLease().where(ownedRow(lease)).limit(1);
      return row ? { cancelRequested: row.cancelRequested } : null;
    },

    async readMany(threadIds) {
      if (threadIds.length === 0) return new Map<ThreadId, ThreadLeaseState>();
      const rows = await selectLiveLease().where(
        and(
          inArray(schema.threadRunLeases.threadId, threadIds as string[]),
          gt(schema.threadRunLeases.expiresAt, new Date()),
        ),
      );
      return new Map(
        rows.map((row) => [
          row.threadId as ThreadId,
          { status: toThreadStatus(row), runningTurnId: row.turnId, currentTool: row.currentTool },
        ]),
      );
    },

    async readOpenExecutionId(threadId) {
      const [row] = await db_()
        .select({ executionId: schema.threadRunLeases.executionId })
        .from(schema.threadRunLeases)
        .where(
          and(
            eq(schema.threadRunLeases.threadId, threadId),
            sql`EXISTS (SELECT 1 FROM ${schema.turns} WHERE ${schema.turns.threadId} = ${schema.threadRunLeases.threadId}
                AND ${schema.turns.executionId} IS NOT NULL
                AND ${schema.turns.executionId}::text = ${schema.threadRunLeases.executionId})`,
          ),
        )
        .limit(1);
      return row?.executionId ?? null;
    },

    async readRunningTurnId(threadId) {
      const [row] = await db_()
        .select({ turnId: schema.threadRunLeases.turnId })
        .from(schema.threadRunLeases)
        .where(liveLeaseWhere(threadId))
        .limit(1);
      return row?.turnId ?? null;
    },

    async requestCancel(threadIds) {
      if (threadIds.length === 0) return;
      await db_()
        .update(schema.threadRunLeases)
        .set({ cancelRequested: true })
        .where(
          and(
            inArray(schema.threadRunLeases.threadId, threadIds as string[]),
            gt(schema.threadRunLeases.expiresAt, new Date()),
          ),
        );
    },

    async fenceWakes(threadIds) {
      if (threadIds.length === 0) return;
      await db_()
        .update(schema.threads)
        .set({ wakeFenceAt: DB_NOW })
        .where(inArray(schema.threads.id, threadIds as string[]));
    },

    async wakeRefusal({ sender, receiver }) {
      const leases = schema.threadRunLeases;
      const [lease] = await db_()
        .select({
          cancelRequested: leases.cancelRequested,
          fenced: receiver
            ? sql<boolean>`EXISTS (SELECT 1 FROM ${schema.threads}
                WHERE ${schema.threads.id} = ${receiver}
                  AND ${schema.threads.wakeFenceAt} > ${leases.acquiredAt})`
            : sql<boolean>`FALSE`,
        })
        .from(leases)
        .where(
          and(eq(leases.threadId, sender.threadId), eq(leases.executionId, sender.executionId)),
        )
        .limit(1);
      if (!lease || lease.cancelRequested) return "sender_stopped";
      return lease.fenced ? "receiver_stopped" : null;
    },

    async cancelExecution(threadId, turnId) {
      return runInDrizzleTransaction(db, async () => {
        const rows = await db_()
          .update(schema.threadRunLeases)
          .set({ cancelRequested: true })
          .where(
            and(
              eq(schema.threadRunLeases.threadId, threadId),
              sql`${turnId} = ANY(${schema.threadRunLeases.boundTurnIds})`,
              gt(schema.threadRunLeases.expiresAt, new Date()),
            ),
          )
          .returning({ turnId: schema.threadRunLeases.turnId });
        if (rows.length === 0) return false;
        return true;
      });
    },

    async listExpiredExecutions(limit, afterThreadId) {
      const rows = await db_()
        .select({ threadId: schema.threadRunLeases.threadId })
        .from(schema.threadRunLeases)
        .where(
          and(
            lte(schema.threadRunLeases.expiresAt, new Date()),
            afterThreadId ? gt(schema.threadRunLeases.threadId, afterThreadId) : undefined,
          ),
        )
        .orderBy(asc(schema.threadRunLeases.threadId))
        .limit(limit);
      return rows.map((row) => row.threadId as ThreadId);
    },

    async abandon(lease) {
      const entry = held.get(lease.threadId);
      try {
        await db_()
          .update(schema.threadRunLeases)
          .set({ expiresAt: new Date() })
          .where(ownedRow(lease));
      } finally {
        if (entry?.executionId === lease.executionId && entry.holderId === lease.holderId) {
          await entry.claim.release();
          if (held.get(lease.threadId) === entry) held.delete(lease.threadId);
        }
      }
    },

    async release(lease) {
      const entry = held.get(lease.threadId);
      const deleted = await db_().delete(schema.threadRunLeases).where(ownedRow(lease)).returning({
        turnId: schema.threadRunLeases.turnId,
        adoptedMessageIds: schema.threadRunLeases.adoptedMessageIds,
      });
      const [gone] = deleted;
      if (gone && (await leaseWasVisible(lease, gone))) markRunStateChanged(lease.threadId);
      if (entry?.executionId !== lease.executionId || entry.holderId !== lease.holderId)
        return deleted.length > 0;

      const unlock = async () => {
        if (held.get(lease.threadId) !== entry) return;
        await entry.claim.release();
        if (held.get(lease.threadId) === entry) held.delete(lease.threadId);
      };
      await runAfterDrizzleCommit(unlock);
      return deleted.length > 0;
    },
  };
}
