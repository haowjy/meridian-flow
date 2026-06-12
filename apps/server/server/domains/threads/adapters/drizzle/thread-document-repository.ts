// @ts-nocheck
/** Drizzle ThreadDocumentRepository: SQL for thread_documents attach/detach/list. */
import type { ThreadDocumentRelationship } from "@meridian/contracts/protocol";
import * as schema from "@meridian/database/schema";
import { and, desc, eq } from "drizzle-orm";
import { toIsoString } from "../../domain/contract-serialization.js";
import type { ThreadDocument, ThreadDocumentRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

function mapThreadDocument(row: typeof schema.threadDocuments.$inferSelect): ThreadDocument {
  return {
    threadId: row.threadId,
    documentId: row.documentId,
    relationship: row.relationship as ThreadDocumentRelationship,
    firstTouchedAt: toIsoString(row.firstTouchedAt),
    lastTouchedAt: toIsoString(row.lastTouchedAt),
  };
}

export function createDrizzleThreadDocumentRepository(db: DrizzleDb): ThreadDocumentRepository {
  return {
    async attach(threadId, documentId, relationship) {
      const now = new Date();
      const [row] = await currentDrizzleDb(db)
        .insert(schema.threadDocuments)
        .values({ threadId, documentId, relationship, firstTouchedAt: now, lastTouchedAt: now })
        .onConflictDoUpdate({
          target: [schema.threadDocuments.threadId, schema.threadDocuments.documentId],
          set: { relationship, lastTouchedAt: now },
        })
        .returning();
      if (!row) throw new Error("Failed to attach thread document");
      return mapThreadDocument(row);
    },
    async detach(threadId, documentId) {
      await currentDrizzleDb(db)
        .delete(schema.threadDocuments)
        .where(
          and(
            eq(schema.threadDocuments.threadId, threadId),
            eq(schema.threadDocuments.documentId, documentId),
          ),
        );
    },
    async listByThread(threadId) {
      const rows = await currentDrizzleDb(db)
        .select()
        .from(schema.threadDocuments)
        .where(eq(schema.threadDocuments.threadId, threadId))
        .orderBy(desc(schema.threadDocuments.lastTouchedAt));
      return rows.map(mapThreadDocument);
    },
  };
}
