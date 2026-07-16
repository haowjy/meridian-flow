/** Delivers committed change-trail outbox rows through the durable thread journal. */

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

export type ChangeTrailDispatcher = { drain(): Promise<number> };

export function createDrizzleChangeTrailDispatcher(input: {
  db: Database;
  journalWriter: EventJournalWriter;
  eventHub: Pick<ThreadEventHub, "publishPersistedEvent">;
}): ChangeTrailDispatcher {
  async function dispatchOne(): Promise<boolean> {
    const persisted = await runInRootDrizzleTransaction(input.db, async () => {
      const tx = currentDrizzleDb(input.db);
      // A claimed predecessor remains visible as undelivered, so SKIP LOCKED can
      // parallelize trails without allowing a later version of one trail past it.
      const rows = await tx.execute(sql`
        SELECT candidate.event_id
        FROM change_trail_delivery_outbox candidate
        WHERE candidate.delivered_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM change_trail_delivery_outbox predecessor
            WHERE predecessor.trail_id = candidate.trail_id
              AND predecessor.delivered_at IS NULL
              AND (predecessor.version < candidate.version OR (
                predecessor.version = candidate.version
                AND predecessor.event_kind = 'updated'
                AND candidate.event_kind = 'settled'
              ))
          )
        ORDER BY candidate.created_at, candidate.event_id
        FOR UPDATE OF candidate SKIP LOCKED
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
          changes: changeTrailDeliveryOutbox.changeCount,
          swept: changeTrailDeliveryOutbox.sweptChangeCount,
          documents: changeTrailDeliveryOutbox.documentCount,
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
              counts: {
                changes: row.changes as number,
                swept: row.swept as number,
                documents: row.documents as number,
              },
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
    async drain() {
      let count = 0;
      while (await dispatchOne()) count += 1;
      return count;
    },
  };
}
