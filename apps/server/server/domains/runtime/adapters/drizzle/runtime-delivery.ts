/** PostgreSQL delivery boundary: inbox, guarded receipt, turn graph and journal share one ambient transaction. */
import type { Database } from "@meridian/database";
import * as schema from "@meridian/database/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { currentDrizzleDb, runAfterDrizzleCommit } from "../../../../shared/drizzle-transaction.js";
import type { Lease } from "../../loop/ports.js";
import { createDrizzleInbox } from "../drizzle-inbox.js";
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
      eq(schema.threadRunLeases.runId, lease.runId),
      eq(schema.threadRunLeases.holderId, lease.holderId),
    );
  const leaseStore: DeliveryLeaseStore = {
    async bindTurn(lease, turnId, messageIds) {
      const [bound] = await db_()
        .update(schema.threadRunLeases)
        .set({ turnId, adoptedMessageIds: [...messageIds] })
        .where(
          and(
            eq(schema.threadRunLeases.cancelRequested, false),
            sql`EXISTS (SELECT 1 FROM ${schema.turns} WHERE ${schema.turns.id} = ${turnId}
                AND ${schema.turns.threadId} = ${lease.threadId} AND ${schema.turns.role} = 'assistant')`,
            ownedLease(lease),
          ),
        )
        .returning({ turnId: schema.threadRunLeases.turnId });
      if (!bound) throw new Error("Cannot bind assistant turn after losing live run lease");
    },

    async setAdoptedMessageIds(lease, messageIds) {
      const rows = await db_()
        .update(schema.threadRunLeases)
        .set({ adoptedMessageIds: [...messageIds] })
        .where(and(ownedLease(lease), isNotNull(schema.threadRunLeases.turnId)))
        .returning({ turnId: schema.threadRunLeases.turnId });
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
    threadLock: createDrizzleThreadLock(db),
    schedulePostCommit: runAfterDrizzleCommit,
  });
}
