/** Drizzle TurnDocumentTouchRepository: SQL for turn_document_touches record/list. */
import * as schema from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { runIsolatedFromAmbientTransaction } from "../../../../shared/drizzle-transaction.js";
import { toIsoString } from "../../domain/contract-serialization.js";
import type { TurnDocumentTouch, TurnDocumentTouchRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

function mapTurnDocumentTouch(
  row: typeof schema.turnDocumentTouches.$inferSelect & { threadId: string },
): TurnDocumentTouch {
  return {
    id: row.id,
    turnId: row.turnId,
    documentId: row.documentId,
    threadId: row.threadId,
    touchedAt: toIsoString(row.touchedAt),
  };
}

export function createDrizzleTurnDocumentTouchRepository(
  db: DrizzleDatabase,
): TurnDocumentTouchRepository {
  return {
    // A touch is best-effort: inside a commit its failure rolls back only its savepoint.
    recordTouch: (turnId, documentId) =>
      runIsolatedFromAmbientTransaction(db, async () => {
        const [turn] = await currentDrizzleDb(db)
          .select({ threadId: schema.turns.threadId })
          .from(schema.turns)
          .where(eq(schema.turns.id, turnId))
          .limit(1);
        if (!turn) throw new Error(`Turn not found: ${turnId}`);
        const now = new Date();
        const [row] = await currentDrizzleDb(db)
          .insert(schema.turnDocumentTouches)
          .values({ turnId, documentId, threadId: turn.threadId, touchedAt: now })
          .onConflictDoUpdate({
            target: [schema.turnDocumentTouches.turnId, schema.turnDocumentTouches.documentId],
            set: { touchedAt: now },
          })
          .returning();
        if (!row) throw new Error("Failed to record document touch");
        return mapTurnDocumentTouch({ ...row, threadId: turn.threadId });
      }),
    async listByThread(threadId, limit) {
      // `family` is the thread and its subagents (a fork is a chat of its own). A subagent's work
      // is the chat's. A document is listed when one of them touched it or wrote text to it
      // (document_edits; a touch is best-effort, so an edit alone counts, as in the related read).
      const rows = await currentDrizzleDb(db).execute<{
        document_id: string;
        touched_at: Date | string;
        edited: boolean;
      }>(sql`
        WITH RECURSIVE family AS (
          SELECT id, 0 AS depth FROM threads WHERE id = ${threadId}
          UNION ALL
          SELECT t.id, family.depth + 1 FROM threads t JOIN family ON t.parent_thread_id = family.id
          WHERE t.kind <> 'primary' AND family.depth < 32
        )
        SELECT document_id, max(at) AS touched_at, bool_or(edited) AS edited FROM (
          SELECT x.document_id, x.touched_at AS at, false AS edited
          FROM turn_document_touches x
          JOIN turns ON turns.id = x.turn_id
          WHERE turns.thread_id IN (SELECT id FROM family)
          UNION ALL
          SELECT e.document_id, e.created_at, true
          FROM document_edits e
          WHERE e.thread_id IN (SELECT id FROM family)
            AND e.actor = 'agent' AND e.kind = 'write' AND e.tree_change IS NULL
        ) seen
        GROUP BY document_id
        ORDER BY max(at) DESC, document_id
        ${typeof limit === "number" ? sql`LIMIT ${limit}` : sql``}
      `);
      return rows.map((row) => ({
        documentId: row.document_id,
        threadId,
        touchedAt: new Date(row.touched_at).toISOString(),
        edited: row.edited,
      }));
    },
  };
}
