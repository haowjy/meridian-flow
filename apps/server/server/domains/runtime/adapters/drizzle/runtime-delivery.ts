/** PostgreSQL delivery boundary: inbox, guarded receipt, turn graph and journal share one ambient transaction. */
import type { Database } from "@meridian/database";
import * as schema from "@meridian/database/schema";
import { pendingPlaceholderPredicate } from "@meridian/database/schema/pending-placeholder";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { currentDrizzleDb, runAfterDrizzleCommit } from "../../../../shared/drizzle-transaction.js";
import type { Lease } from "../../loop/ports.js";
import { createDrizzleInbox } from "../drizzle-inbox.js";
import { markRunStateChanged } from "../drizzle-run-state.js";
import { createDrizzleThreadLock } from "../drizzle-thread-lock.js";
import { createDeliveryAdapter, type DeliveryLeaseStore } from "../runtime-delivery.js";

export function createDrizzleRuntimeDelivery(
  db: Database,
  deps: Omit<
    Parameters<typeof createDeliveryAdapter>[0],
    "inbox" | "leaseStore" | "threadLock" | "schedulePostCommit"
  >,
) {
  const db_ = () => currentDrizzleDb(db);
  const ownedLease = (lease: Lease) =>
    and(
      eq(schema.threadRunLeases.threadId, lease.threadId),
      eq(schema.threadRunLeases.executionId, lease.executionId),
      eq(schema.threadRunLeases.holderId, lease.holderId),
    );
  const leaseStore: DeliveryLeaseStore = {
    // Role guard mirrors currentTurnKind; compaction additionally requires a pending placeholder.
    async bindTurn(lease, turnId, messageIds, kind) {
      const [bound] = await db_()
        .update(schema.threadRunLeases)
        .set({
          turnId,
          adoptedMessageIds: [...messageIds],
          boundTurnIds: sql`array_append(${schema.threadRunLeases.boundTurnIds}, ${turnId}::uuid)`,
        })
        .where(
          and(
            eq(schema.threadRunLeases.cancelRequested, false),
            sql`EXISTS (SELECT 1 FROM ${schema.turns} WHERE ${schema.turns.id} = ${turnId}
                AND ${schema.turns.threadId} = ${lease.threadId} AND ${schema.turns.role} = ${kind} AND (${schema.turns.role} = 'assistant' OR ${pendingPlaceholderPredicate({ role: schema.turns.role, status: schema.turns.status })}))`,
            ownedLease(lease),
          ),
        )
        .returning({ turnId: schema.threadRunLeases.turnId });
      if (!bound) throw new Error("Cannot bind current turn after losing live run lease");
      markRunStateChanged(lease.threadId);
    },

    async setAdoptedMessageIds(lease, messageIds) {
      const rows = await db_()
        .update(schema.threadRunLeases)
        .set({ adoptedMessageIds: [...messageIds] })
        .where(and(ownedLease(lease), isNotNull(schema.threadRunLeases.turnId)))
        .returning({ turnId: schema.threadRunLeases.turnId });
      if (rows.length > 0) markRunStateChanged(lease.threadId);
      return rows.length > 0;
    },

    async clearReceipt(lease, expectedIds) {
      const rows = await db_()
        .update(schema.threadRunLeases)
        .set({ adoptedMessageIds: [] })
        .where(
          and(ownedLease(lease), eq(schema.threadRunLeases.adoptedMessageIds, [...expectedIds])),
        )
        .returning({ threadId: schema.threadRunLeases.threadId });
      if (rows.length > 0) markRunStateChanged(lease.threadId);
      return rows.length > 0;
    },
    async clearOrphanedReceipt(threadId, turnId, expectedIds) {
      const rows = await db_()
        .update(schema.threadRunLeases)
        .set({ turnId: null, boundTurnIds: [], adoptedMessageIds: [] })
        .where(
          and(
            eq(schema.threadRunLeases.threadId, threadId),
            eq(schema.threadRunLeases.turnId, turnId),
            eq(schema.threadRunLeases.adoptedMessageIds, [...expectedIds]),
          ),
        )
        .returning({ threadId: schema.threadRunLeases.threadId });
      if (rows.length > 0) markRunStateChanged(threadId);
      return rows.length > 0;
    },
    async cancelThreadReceipt(threadId, turnId) {
      const rows = await db_()
        .update(schema.threadRunLeases)
        .set({ cancelRequested: true })
        .where(
          and(
            eq(schema.threadRunLeases.threadId, threadId),
            eq(schema.threadRunLeases.turnId, turnId),
          ),
        )
        .returning({ turnId: schema.threadRunLeases.turnId });
      return rows.length > 0;
    },
    async lockThreadReceipt(threadId) {
      const [row] = await db_()
        .select({
          ids: schema.threadRunLeases.adoptedMessageIds,
          turnId: schema.threadRunLeases.turnId,
          executionId: schema.threadRunLeases.executionId,
          holderId: schema.threadRunLeases.holderId,
        })
        .from(schema.threadRunLeases)
        .where(and(eq(schema.threadRunLeases.threadId, threadId)))
        .for("update");
      return row
        ? {
            ids: row.ids,
            turnId: row.turnId,
            lease: { threadId, executionId: row.executionId, holderId: row.holderId },
          }
        : null;
    },
    async lockStaleExecution(threadId) {
      const [row] = await db_()
        .select({ executionId: schema.threadRunLeases.executionId })
        .from(schema.threadRunLeases)
        .where(eq(schema.threadRunLeases.threadId, threadId))
        .for("update");
      return row ?? null;
    },
    async deleteStaleExecution(threadId, executionId) {
      const rows = await db_()
        .delete(schema.threadRunLeases)
        .where(
          and(
            eq(schema.threadRunLeases.threadId, threadId),
            eq(schema.threadRunLeases.executionId, executionId),
          ),
        )
        .returning({ threadId: schema.threadRunLeases.threadId });
      if (rows.length > 0) markRunStateChanged(threadId);
      return rows.length > 0;
    },
    async lockReceipt(lease) {
      const [row] = await db_()
        .select({
          ids: schema.threadRunLeases.adoptedMessageIds,
          cancelRequested: schema.threadRunLeases.cancelRequested,
        })
        .from(schema.threadRunLeases)
        .where(ownedLease(lease))
        .for("update");
      return row ?? null;
    },
  };
  return createDeliveryAdapter({
    ...deps,
    inbox: createDrizzleInbox(db),
    leaseStore,
    threadLock: createDrizzleThreadLock(db, deps.eventWriter),
    schedulePostCommit: runAfterDrizzleCommit,
  });
}
