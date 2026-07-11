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
    const turnShells = (owners as unknown as Array<{ thread_id: string; turn_id: string }>).map(
      (owner) => ({
        ...owner,
        id: trailIdForOwner({
          kind: "turn",
          threadId: owner.thread_id,
          turnId: owner.turn_id,
        }),
      }),
    );
    const mutableShells = await tx.execute(sql`
      SELECT shell.id
      FROM change_trail_shells shell
      WHERE (shell.turn_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM turns turn
          WHERE turn.id = shell.turn_id AND turn.status IN ('complete', 'cancelled', 'error')
        )) OR (shell.owner_kind = 'shared' AND NOT EXISTS (
          SELECT 1 FROM turns turn
          WHERE turn.thread_id = shell.thread_id
            AND turn.status NOT IN ('complete', 'cancelled', 'error')
        ))
    `);
    const lockedTrailIds = new Set([
      ...turnShells.map((owner) => owner.id),
      ...(mutableShells as unknown as Array<{ id: string }>).map((shell) => shell.id),
    ]);
    for (const id of [...lockedTrailIds].sort()) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
    }
    for (const owner of turnShells) {
      await tx
        .insert(changeTrailShells)
        .values({
          id: owner.id,
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
      RETURNING shell.id, shell.thread_id, shell.version, shell.change_count,
        shell.swept_change_count, shell.document_count
    `);
    for (const item of reopened as unknown as Array<{
      id: string;
      thread_id: string;
      version: number;
      change_count: number;
      swept_change_count: number;
      document_count: number;
    }>) {
      await tx
        .insert(changeTrailDeliveryOutbox)
        .values({
          eventId: eventUuid(`change-trail-event:${item.id}:${item.version}:updated`),
          threadId: item.thread_id as never,
          trailId: item.id,
          version: item.version,
          eventKind: "updated",
          changeCount: item.change_count,
          sweptChangeCount: item.swept_change_count,
          documentCount: item.document_count,
        })
        .onConflictDoNothing();
    }
    // Settle only trails which entered `settling` in an earlier reconciliation.
    // This preserves a durable, observable settling version between RUN_FINISHED
    // and the terminal event instead of collapsing both states in one poll.
    const ready = await tx.execute(sql`
      SELECT shell.id, shell.version, shell.change_count, shell.swept_change_count,
        shell.document_count
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
    for (const item of ready as unknown as Array<{
      id: string;
      version: number;
      change_count: number;
      swept_change_count: number;
      document_count: number;
    }>) {
      const version = item.version + 1;
      await tx
        .update(changeTrailShells)
        .set({ state: "settled", version, settledAt: new Date(), updatedAt: new Date() })
        .where(and(eq(changeTrailShells.id, item.id), eq(changeTrailShells.state, "settling")));
      await tx
        .insert(changeTrailDeliveryOutbox)
        .values({
          eventId: eventUuid(`change-trail-event:${item.id}:${version}:settled`),
          threadId: sql`(SELECT thread_id FROM change_trail_shells WHERE id = ${item.id})`,
          trailId: item.id,
          version,
          eventKind: "settled",
        })
        .onConflictDoNothing();
    }

    const entering = await tx.execute(sql`
      UPDATE change_trail_shells AS shell
      SET state = 'settling', version = shell.version + 1, updated_at = now()
      FROM turns
      WHERE shell.turn_id = turns.id
        AND shell.state = 'building'
        AND turns.status IN ('complete', 'cancelled', 'error')
      RETURNING shell.id, shell.thread_id, shell.version, shell.change_count,
        shell.swept_change_count, shell.document_count
    `);

    await tx.execute(sql`
      UPDATE change_trail_shells shell SET state = 'settling', version = version + 1, updated_at = now()
      WHERE shell.owner_kind = 'shared' AND shell.state = 'building'
        AND NOT EXISTS (
          SELECT 1 FROM turns turn WHERE turn.thread_id = shell.thread_id
            AND turn.status NOT IN ('complete', 'cancelled', 'error')
        )
    `);
    for (const item of entering as unknown as Array<{
      id: string;
      thread_id: string;
      version: number;
      change_count: number;
      swept_change_count: number;
      document_count: number;
    }>) {
      await tx
        .insert(changeTrailDeliveryOutbox)
        .values({
          eventId: eventUuid(`change-trail-event:${item.id}:${item.version}:updated`),
          threadId: item.thread_id,
          trailId: item.id,
          version: item.version,
          eventKind: "updated",
          changeCount: item.change_count,
          sweptChangeCount: item.swept_change_count,
          documentCount: item.document_count,
        })
        .onConflictDoNothing();
    }
  });
}
