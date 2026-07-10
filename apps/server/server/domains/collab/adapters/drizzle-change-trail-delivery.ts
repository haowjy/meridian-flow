/** Delivers committed change-trail outbox rows through the durable thread journal. */

import { createHash } from "node:crypto";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { changeTrailDeliveryOutbox, changeTrailShells } from "@meridian/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type { EventJournalWriter } from "../../threads/ports/index.js";
import type { ThreadEventHub } from "../../threads/thread-event-hub.js";

export type ChangeTrailDeliveryDispatcher = {
  dispatchOne(): Promise<boolean>;
  drain(): Promise<number>;
};

function eventUuid(namespace: string): string {
  const bytes = Buffer.from(createHash("sha256").update(namespace).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createChangeTrailDeliveryDispatcher(input: {
  db: Database;
  journalWriter: EventJournalWriter;
  eventHub: Pick<ThreadEventHub, "publishPersistedEvent">;
}): ChangeTrailDeliveryDispatcher {
  async function dispatchOne(): Promise<boolean> {
    const persisted = await runInRootDrizzleTransaction(input.db, async () => {
      const tx = currentDrizzleDb(input.db);
      // SKIP LOCKED lets several server processes drain safely without a process-level lease.
      const rows = await tx.execute(sql`
        SELECT event_id
        FROM change_trail_delivery_outbox
        WHERE delivered_at IS NULL
        ORDER BY created_at, CASE event_kind WHEN 'updated' THEN 0 ELSE 1 END, event_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const eventId = (rows[0] as { event_id?: string } | undefined)?.event_id;
      if (!eventId) return null;

      const [row] = await tx
        .select({
          eventId: changeTrailDeliveryOutbox.eventId,
          eventKind: changeTrailDeliveryOutbox.eventKind,
          threadId: changeTrailDeliveryOutbox.threadId,
          trailId: changeTrailDeliveryOutbox.trailId,
          version: changeTrailDeliveryOutbox.version,
          turnId: changeTrailShells.turnId,
          changes: changeTrailShells.changeCount,
          swept: changeTrailShells.sweptChangeCount,
          documents: changeTrailShells.documentCount,
        })
        .from(changeTrailDeliveryOutbox)
        .innerJoin(changeTrailShells, eq(changeTrailShells.id, changeTrailDeliveryOutbox.trailId))
        .where(
          and(
            eq(changeTrailDeliveryOutbox.eventId, eventId),
            isNull(changeTrailDeliveryOutbox.deliveredAt),
          ),
        )
        .limit(1);
      if (!row) return null;

      const event: OrchestratorEvent =
        row.eventKind === "updated"
          ? {
              type: "turn.change_trail_updated",
              eventId: row.eventId,
              threadId: row.threadId,
              trailId: row.trailId,
              turnId: row.turnId,
              version: row.version,
              counts: { changes: row.changes, swept: row.swept, documents: row.documents },
            }
          : {
              type: "turn.change_trail_settled",
              eventId: row.eventId,
              threadId: row.threadId,
              trailId: row.trailId,
              turnId: row.turnId,
              version: row.version,
            };
      const seq = await input.journalWriter.appendEvent(row.threadId, event);
      await tx
        .update(changeTrailDeliveryOutbox)
        .set({ deliveredAt: new Date() })
        .where(eq(changeTrailDeliveryOutbox.eventId, row.eventId));
      return { event, seq };
    });

    if (persisted) {
      input.eventHub.publishPersistedEvent(
        persisted.event.threadId,
        persisted.seq,
        persisted.event,
      );
    }
    return persisted !== null;
  }

  return {
    dispatchOne,
    async drain() {
      await reconcileTerminalTurns(input.db);
      let count = 0;
      while (await dispatchOne()) count += 1;
      return count;
    },
  };
}

/** Advances turn trails only after the terminal turn policy has covered every owned row. */
async function reconcileTerminalTurns(db: Database): Promise<void> {
  await runInRootDrizzleTransaction(db, async () => {
    const tx = currentDrizzleDb(db);
    // Settle only trails which entered `settling` in an earlier reconciliation.
    // This preserves a durable, observable settling version between RUN_FINISHED
    // and the terminal event instead of collapsing both states in one poll.
    const ready = await tx.execute(sql`
      SELECT shell.id, shell.version
      FROM change_trail_shells AS shell
      WHERE shell.state = 'settling'
        AND shell.turn_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM branch_write_journal AS journal
          WHERE journal.thread_id = shell.thread_id
            AND journal.turn_id = shell.turn_id
            AND journal.status IN ('active', 'rollback_pending')
        )
      FOR UPDATE SKIP LOCKED
    `);
    for (const item of ready as unknown as Array<{ id: string; version: number }>) {
      const version = item.version + 1;
      await tx
        .update(changeTrailShells)
        .set({ state: "settled", version, settledAt: new Date(), updatedAt: new Date() })
        .where(and(eq(changeTrailShells.id, item.id), eq(changeTrailShells.state, "settling")));
      for (const eventKind of ["updated", "settled"] as const) {
        await tx
          .insert(changeTrailDeliveryOutbox)
          .values({
            eventId: eventUuid(`change-trail-event:${item.id}:${version}:${eventKind}`),
            threadId: sql`(SELECT thread_id FROM change_trail_shells WHERE id = ${item.id})`,
            trailId: item.id,
            version,
            eventKind,
          })
          .onConflictDoNothing();
      }
    }

    const entering = await tx.execute(sql`
      UPDATE change_trail_shells AS shell
      SET state = 'settling', version = shell.version + 1, updated_at = now()
      FROM turns
      WHERE shell.turn_id = turns.id
        AND shell.state = 'building'
        AND turns.status IN ('complete', 'cancelled', 'error')
      RETURNING shell.id, shell.thread_id, shell.version
    `);
    for (const item of entering as unknown as Array<{
      id: string;
      thread_id: string;
      version: number;
    }>) {
      await tx
        .insert(changeTrailDeliveryOutbox)
        .values({
          eventId: eventUuid(`change-trail-event:${item.id}:${item.version}:updated`),
          threadId: item.thread_id,
          trailId: item.id,
          version: item.version,
          eventKind: "updated",
        })
        .onConflictDoNothing();
    }
  });
}
