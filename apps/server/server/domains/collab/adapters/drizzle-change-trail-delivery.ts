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
import { trailIdForOwner } from "./drizzle-change-trails.js";

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
  retryBranch?: (branchId: string) => Promise<unknown>;
  onRetryExhausted?: (threadId: string, documentId: string) => void;
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
      await retryTurnWork(input.db, input.retryBranch, input.onRetryExhausted);
      await reconcileTerminalTurns(input.db);
      let count = 0;
      while (await dispatchOne()) count += 1;
      return count;
    },
  };
}

const MAX_WORK_ATTEMPTS = 5;

/** Claims one durable unit. A crash leaves `running`, which the next poll reclaims. */
async function retryTurnWork(
  db: Database,
  retryBranch: ((branchId: string) => Promise<unknown>) | undefined,
  onRetryExhausted: ((threadId: string, documentId: string) => void) | undefined,
): Promise<void> {
  const claimed = await runInRootDrizzleTransaction(db, async () => {
    const tx = currentDrizzleDb(db);
    const rows = await tx.execute(sql`
      SELECT work.journal_id, work.branch_id, work.thread_id, work.attempts,
        branch.push_policy, branch.document_id, turn.status
      FROM turn_trail_work work
      JOIN document_branches branch ON branch.id = work.branch_id
      JOIN turns turn ON turn.id = work.turn_id
      WHERE (work.state = 'pending' AND work.next_attempt_at <= now())
         OR (work.state = 'running' AND work.updated_at < now() - interval '30 seconds')
      ORDER BY work.next_attempt_at, work.journal_id
      FOR UPDATE OF work SKIP LOCKED LIMIT 1
    `);
    const row = rows[0] as
      | {
          journal_id: number;
          branch_id: string;
          thread_id: string;
          document_id: string;
          attempts: number;
          push_policy: string;
          status: string;
        }
      | undefined;
    if (!row) return null;
    if (row.push_policy !== "auto" || ["cancelled", "error"].includes(row.status)) {
      await tx.execute(
        sql`UPDATE turn_trail_work SET state = 'no_op', updated_at = now() WHERE journal_id = ${row.journal_id}`,
      );
      return null;
    }
    await tx.execute(
      sql`UPDATE turn_trail_work SET state = 'running', attempts = attempts + 1, updated_at = now() WHERE journal_id = ${row.journal_id}`,
    );
    return row;
  });
  if (!claimed || !retryBranch) return;
  try {
    await retryBranch(claimed.branch_id);
  } catch (cause) {
    const attempts = claimed.attempts + 1;
    const exhausted = attempts >= MAX_WORK_ATTEMPTS;
    const delaySeconds = Math.min(2 ** attempts, 30);
    await db.execute(sql`
      UPDATE turn_trail_work SET
        state = ${exhausted ? "exhausted" : "pending"},
        next_attempt_at = now() + (${delaySeconds} * interval '1 second'),
        last_error = ${cause instanceof Error ? cause.message : String(cause)}, updated_at = now()
      WHERE journal_id = ${claimed.journal_id} AND state = 'running'
    `);
    if (exhausted) onRetryExhausted?.(claimed.thread_id, claimed.document_id);
    return;
  }
  await db.execute(sql`
    UPDATE turn_trail_work work SET
      state = CASE WHEN journal.status IN ('pushed', 'discarded') THEN 'complete' ELSE 'pending' END,
      next_attempt_at = now() + interval '1 second', updated_at = now()
    FROM branch_write_journal journal
    WHERE work.journal_id = ${claimed.journal_id} AND journal.id = work.journal_id
  `);
}

/** Advances turn trails only after the terminal turn policy has covered every owned row. */
async function reconcileTerminalTurns(db: Database): Promise<void> {
  await runInRootDrizzleTransaction(db, async () => {
    const tx = currentDrizzleDb(db);
    const owners = await tx.execute(sql`
      SELECT DISTINCT work.thread_id, work.turn_id
      FROM turn_trail_work work
      JOIN turns turn ON turn.id = work.turn_id
      WHERE turn.status IN ('complete', 'cancelled', 'error')
    `);
    for (const owner of owners as unknown as Array<{ thread_id: string; turn_id: string }>) {
      const id = trailIdForOwner({
        kind: "turn",
        threadId: owner.thread_id,
        turnId: owner.turn_id,
      });
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
      await tx
        .insert(changeTrailShells)
        .values({
          id,
          threadId: owner.thread_id as never,
          turnId: owner.turn_id as never,
          ownerKind: "turn",
          changeCount: 0,
          sweptChangeCount: 0,
          documentCount: 0,
        })
        .onConflictDoNothing();
    }
    const reopened = await tx.execute(sql`
      UPDATE change_trail_shells shell SET state = 'building', version = version + 1,
        settled_at = NULL, updated_at = now()
      WHERE shell.state = 'settled' AND EXISTS (
        SELECT 1 FROM turn_trail_work work
        WHERE work.thread_id = shell.thread_id
          AND (shell.owner_kind = 'shared' OR work.turn_id = shell.turn_id)
          AND work.updated_at > shell.settled_at
      )
      RETURNING shell.id, shell.thread_id, shell.version
    `);
    for (const item of reopened as unknown as Array<{
      id: string;
      thread_id: string;
      version: number;
    }>) {
      await tx
        .insert(changeTrailDeliveryOutbox)
        .values({
          eventId: eventUuid(`change-trail-event:${item.id}:${item.version}:updated`),
          threadId: item.thread_id as never,
          trailId: item.id,
          version: item.version,
          eventKind: "updated",
        })
        .onConflictDoNothing();
    }
    // Settle only trails which entered `settling` in an earlier reconciliation.
    // This preserves a durable, observable settling version between RUN_FINISHED
    // and the terminal event instead of collapsing both states in one poll.
    const ready = await tx.execute(sql`
      SELECT shell.id, shell.version
      FROM change_trail_shells AS shell
      WHERE shell.state = 'settling'
        AND (
          (shell.turn_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM turn_trail_work work
            WHERE work.thread_id = shell.thread_id AND work.turn_id = shell.turn_id
              AND work.state NOT IN ('complete', 'no_op')
          ))
          OR (shell.owner_kind = 'shared' AND NOT EXISTS (
            SELECT 1 FROM turn_trail_work work
            JOIN turns turn ON turn.id = work.turn_id
            WHERE work.thread_id = shell.thread_id
              AND (work.state NOT IN ('complete', 'no_op') OR turn.status NOT IN ('complete', 'cancelled', 'error'))
          ))
        )
        AND NOT EXISTS (
          SELECT 1 FROM branch_write_journal AS journal
          WHERE journal.thread_id = shell.thread_id
            AND journal.turn_id = shell.turn_id
            AND journal.status IN ('active', 'rollback_pending')
            AND NOT EXISTS (SELECT 1 FROM turn_trail_work work WHERE work.journal_id = journal.id AND work.state = 'no_op')
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

    // Error/cancel rollback reverses the response's live effects. Rebuild its
    // projection from the surviving evidence (none for the reversed response)
    // before publishing the terminal counts.
    await tx.execute(sql`
      DELETE FROM change_trail_document_details detail USING change_trail_shells shell, turns
      WHERE detail.trail_id = shell.id AND shell.turn_id = turns.id
        AND shell.state = 'building' AND turns.status IN ('cancelled', 'error')
    `);
    await tx.execute(sql`
      UPDATE change_trail_shells shell SET change_count = 0, swept_change_count = 0,
        document_count = 0, updated_at = now()
      FROM turns WHERE shell.turn_id = turns.id AND shell.state = 'building'
        AND turns.status IN ('cancelled', 'error')
    `);

    const entering = await tx.execute(sql`
      UPDATE change_trail_shells AS shell
      SET state = 'settling', version = shell.version + 1, updated_at = now()
      FROM turns
      WHERE shell.turn_id = turns.id
        AND shell.state = 'building'
        AND turns.status IN ('complete', 'cancelled', 'error')
      RETURNING shell.id, shell.thread_id, shell.version
    `);

    await tx.execute(sql`
      UPDATE change_trail_shells shell SET state = 'settling', version = version + 1, updated_at = now()
      WHERE shell.owner_kind = 'shared' AND shell.state = 'building'
        AND EXISTS (SELECT 1 FROM turn_trail_work work WHERE work.thread_id = shell.thread_id)
        AND NOT EXISTS (
          SELECT 1 FROM turn_trail_work work JOIN turns turn ON turn.id = work.turn_id
          WHERE work.thread_id = shell.thread_id AND turn.status NOT IN ('complete', 'cancelled', 'error')
        )
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
