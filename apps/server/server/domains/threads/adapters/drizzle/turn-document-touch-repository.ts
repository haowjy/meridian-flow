// @ts-nocheck
/** Drizzle TurnDocumentTouchRepository: SQL for turn_document_touches record/list. */
import * as schema from "@meridian/database/schema";
import { desc, eq } from "drizzle-orm";
import { toIsoString } from "../../domain/contract-serialization.js";
import type { TurnDocumentTouch, TurnDocumentTouchRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

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
  db: DrizzleDb,
): TurnDocumentTouchRepository {
  return {
    async recordTouch(turnId, documentId) {
      const [turn] = await currentDrizzleDb(db)
        .select({ threadId: schema.turns.threadId })
        .from(schema.turns)
        .where(eq(schema.turns.id, turnId))
        .limit(1);
      if (!turn) throw new Error(`Turn not found: ${turnId}`);
      const now = toIsoString(new Date());
      const [row] = await currentDrizzleDb(db)
        .insert(schema.turnDocumentTouches)
        .values({ turnId, documentId, touchedAt: now })
        .onConflictDoUpdate({
          target: [schema.turnDocumentTouches.turnId, schema.turnDocumentTouches.documentId],
          set: { touchedAt: now },
        })
        .returning();
      if (!row) throw new Error("Failed to record document touch");
      return mapTurnDocumentTouch({ ...row, threadId: turn.threadId });
    },
    async listByThread(threadId, limit) {
      const rows = await currentDrizzleDb(db)
        .selectDistinctOn([schema.turnDocumentTouches.documentId], {
          id: schema.turnDocumentTouches.id,
          turnId: schema.turnDocumentTouches.turnId,
          documentId: schema.turnDocumentTouches.documentId,
          touchedAt: schema.turnDocumentTouches.touchedAt,
          threadId: schema.turns.threadId,
        })
        .from(schema.turnDocumentTouches)
        .innerJoin(schema.turns, eq(schema.turnDocumentTouches.turnId, schema.turns.id))
        .where(eq(schema.turns.threadId, threadId))
        .orderBy(schema.turnDocumentTouches.documentId, desc(schema.turnDocumentTouches.touchedAt));
      const mapped = rows
        .map(mapTurnDocumentTouch)
        .sort((a, b) => b.touchedAt.localeCompare(a.touchedAt));
      return typeof limit === "number" ? mapped.slice(0, limit) : mapped;
    },
  };
}
