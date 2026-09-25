/**
 * PostgreSQL adapters for cross-process thread-run ownership. The session
 * advisory lock stays the atomic mutex (crash-safe because the DB session
 * dies); `RunClaim` adds the queryable, expiring lease row that
 * `holder()` and derived status can read from another process.
 */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadLeaseState, ThreadStatus } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import * as schema from "@meridian/database/schema";
import { and, eq, gt, inArray } from "drizzle-orm";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import {
  DEFAULT_LEASE_TTL_MS,
  type RunClaim,
  type RunId,
  type ThreadPhase,
} from "../loop/ports.js";

const THREAD_RUN_LOCK_SEED = 81n;

interface ThreadRunLockClaim {
  release(): Promise<void>;
}

interface ThreadRunLock {
  tryAcquire(threadId: ThreadId): Promise<ThreadRunLockClaim | null>;
}

function createThreadRunLock(db: Database): ThreadRunLock {
  // One reserved session owns every run lock for this server process. Holding a
  // pool connection per turn would cap live runs at the ordinary query-pool size.
  let connectionPromise: ReturnType<Database["$client"]["reserve"]> | undefined;
  const localClaims = new Map<string, symbol>();
  let operationChain = Promise.resolve();
  const connection = async () => {
    if (!connectionPromise) connectionPromise = db.$client.reserve();
    const pending = connectionPromise;
    try {
      return await pending;
    } catch (cause) {
      if (connectionPromise === pending) connectionPromise = undefined;
      throw cause;
    }
  };
  const releaseConnectionIfIdle = (
    lockConnection: Awaited<ReturnType<Database["$client"]["reserve"]>>,
  ) => {
    if (localClaims.size !== 0) return;
    connectionPromise = undefined;
    lockConnection.release();
  };
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationChain.then(operation, operation);
    operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    async tryAcquire(threadId) {
      return exclusive(async () => {
        // PostgreSQL session advisory locks are reentrant. This registry makes
        // the adapter's ownership contract exclusive without acting as recovery
        // authority; process death still releases the database session locks.
        if (localClaims.has(threadId)) return null;

        const lockConnection = await connection();
        const lockKey = `meridian:thread-run:${threadId}`;
        try {
          const [row] = await lockConnection<{ acquired: boolean }[]>`
            select pg_try_advisory_lock(
              hashtextextended(${lockKey}, ${THREAD_RUN_LOCK_SEED})
            ) as acquired
          `;
          if (!row?.acquired) {
            releaseConnectionIfIdle(lockConnection);
            return null;
          }
          const claimToken = Symbol(threadId);
          localClaims.set(threadId, claimToken);
          return {
            async release() {
              await exclusive(async () => {
                // A stale claim must not release a newer claim for the same
                // thread after its own successful release.
                if (localClaims.get(threadId) !== claimToken) return;
                const [unlock] = await lockConnection<{ released: boolean }[]>`
                    select pg_advisory_unlock(
                      hashtextextended(${lockKey}, ${THREAD_RUN_LOCK_SEED})
                    ) as released
                  `;
                if (!unlock?.released) {
                  throw new Error(`Thread run claim was not held: ${threadId}`);
                }
                localClaims.delete(threadId);
                releaseConnectionIfIdle(lockConnection);
              });
            },
          };
        } catch (cause) {
          releaseConnectionIfIdle(lockConnection);
          throw cause;
        }
      });
    },
  };
}

export interface DrizzleRunClaimOptions {
  /** Stable holder identity for this worker; a random one is minted when omitted. */
  holderId?: string;
  leaseTtlMs?: number;
}

export function createDrizzleRunClaim(
  db: Database,
  options: DrizzleRunClaimOptions = {},
): RunClaim {
  const lock = createThreadRunLock(db);
  const holderId = options.holderId ?? crypto.randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const held = new Map<ThreadId, { runId: RunId; holderId: string; claim: ThreadRunLockClaim }>();

  const nextExpiry = () => new Date(Date.now() + leaseTtlMs);
  const db_ = () => currentDrizzleDb(db);

  // The one "live lease" predicate; every read and cancel derives from it.
  const liveLeaseWhere = (threadId: ThreadId) =>
    and(
      eq(schema.threadRunLeases.threadId, threadId),
      gt(schema.threadRunLeases.expiresAt, new Date()),
    );

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
      })
      .from(schema.threadRunLeases);

  return {
    async withExclusiveThread(threadId, operation) {
      const claim = await lock.tryAcquire(threadId);
      if (!claim) return null;
      try {
        return await operation();
      } finally {
        await claim.release();
      }
    },
    async startExecution(threadId, runId) {
      const claim = await lock.tryAcquire(threadId);
      if (!claim) return null;
      const acquiredAt = new Date();
      try {
        await db_()
          .insert(schema.threadRunLeases)
          .values({
            threadId,
            runId,
            turnId: null,
            adoptedMessageIds: [],
            holderId,
            phase: "generating",
            cancelRequested: false,
            acquiredAt,
            renewedAt: acquiredAt,
            expiresAt: nextExpiry(),
          })
          .onConflictDoUpdate({
            target: schema.threadRunLeases.threadId,
            set: {
              runId,
              turnId: null,
              adoptedMessageIds: [],
              holderId,
              phase: "generating",
              cancelRequested: false,
              acquiredAt,
              renewedAt: acquiredAt,
              expiresAt: nextExpiry(),
            },
          });
      } catch (cause) {
        await claim.release();
        throw cause;
      }
      held.set(threadId, { runId, holderId, claim });
      return { threadId, runId, holderId };
    },

    async renew(lease) {
      const updated = await db_()
        .update(schema.threadRunLeases)
        .set({ renewedAt: new Date(), expiresAt: nextExpiry() })
        .where(
          and(
            eq(schema.threadRunLeases.threadId, lease.threadId),
            eq(schema.threadRunLeases.runId, lease.runId),
            eq(schema.threadRunLeases.holderId, lease.holderId),
          ),
        )
        .returning({ threadId: schema.threadRunLeases.threadId });
      return updated.length > 0;
    },

    async holder(threadId) {
      const [row] = await db_()
        .select({ runId: schema.threadRunLeases.runId })
        .from(schema.threadRunLeases)
        .where(liveLeaseWhere(threadId))
        .limit(1);
      return row?.runId ?? null;
    },

    async publish(lease, phase) {
      await db_()
        .update(schema.threadRunLeases)
        .set({ phase })
        .where(
          and(
            eq(schema.threadRunLeases.threadId, lease.threadId),
            eq(schema.threadRunLeases.runId, lease.runId),
            eq(schema.threadRunLeases.holderId, lease.holderId),
          ),
        );
    },

    async read(threadId) {
      const [row] = await selectLiveLease().where(liveLeaseWhere(threadId)).limit(1);
      if (!row) return { kind: "asleep" };
      return toThreadStatus(row);
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
          { status: toThreadStatus(row), runningTurnId: row.turnId },
        ]),
      );
    },

    async readRunningTurnId(threadId) {
      const [row] = await db_()
        .select({ turnId: schema.threadRunLeases.turnId })
        .from(schema.threadRunLeases)
        .where(liveLeaseWhere(threadId))
        .limit(1);
      return row?.turnId ?? null;
    },

    async cancelExecution(threadId, turnId) {
      const rows = await db_()
        .update(schema.threadRunLeases)
        .set({ cancelRequested: true })
        .where(
          and(
            eq(schema.threadRunLeases.threadId, threadId),
            eq(schema.threadRunLeases.turnId, turnId),
            gt(schema.threadRunLeases.expiresAt, new Date()),
          ),
        )
        .returning({ turnId: schema.threadRunLeases.turnId });
      return rows.length > 0;
    },

    async release(lease) {
      const entry = held.get(lease.threadId);
      await db_()
        .delete(schema.threadRunLeases)
        .where(
          and(
            eq(schema.threadRunLeases.threadId, lease.threadId),
            eq(schema.threadRunLeases.runId, lease.runId),
            eq(schema.threadRunLeases.holderId, lease.holderId),
          ),
        );
      if (entry?.runId !== lease.runId || entry.holderId !== lease.holderId) return;

      const unlock = async () => {
        // A stale callback must not release a newer run. Keep the entry on
        // unlock failure so the run owner's final release can retry it.
        if (held.get(lease.threadId) !== entry) return;
        await entry.claim.release();
        if (held.get(lease.threadId) === entry) held.delete(lease.threadId);
      };
      // A terminal transaction deletes the lease row atomically with its
      // terminal write. Its physical session lock remains held until the outer
      // commit; rollback leaves both the lease and the claim in place.
      if (!deferUntilDrizzleCommit(unlock)) await unlock();
    },
  };
}
