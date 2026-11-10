/** Drizzle DocumentRelatedReader: touches and agent edits credited to the chat, plus links. */
import * as schema from "@meridian/database/schema";
import { and, desc, eq, like, sql } from "drizzle-orm";
import type { DocumentRelatedReader } from "../../ports/document-related.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

export function createDrizzleDocumentRelatedReader(db: DrizzleDatabase): DocumentRelatedReader {
  return {
    async listChats({ documentId, projectId, userId, limit }) {
      // `actors` holds every thread that touched the document or wrote to it. Each is credited to
      // its nearest `primary` ancestor (a subagent to its chat); a fork has no parent, so it is
      // its own chat. `edited` reads document_edits, which is written in the edit's transaction;
      // a touch can come from a read, and is best-effort. Undo, redo, revert and rollback rows
      // are not edits. The depth cap keeps a corrupt cycle from running away.
      const rows = await currentDrizzleDb(db).execute<{
        chat_id: string;
        title: string;
        work_id: string | null;
        touched_at: Date | string;
        edited: boolean;
      }>(sql`
        WITH RECURSIVE actors AS (
          SELECT thread_id, max(at) AS at, bool_or(edited) AS edited FROM (
            SELECT thread_id, touched_at AS at, false AS edited
            FROM turn_document_touches WHERE document_id = ${documentId}
            UNION ALL
            SELECT thread_id, created_at AS at, true AS edited
            FROM document_edits
            WHERE document_id = ${documentId} AND thread_id IS NOT NULL
              AND actor = 'agent' AND kind = 'write'
          ) seen GROUP BY thread_id
        ), chain AS (
          SELECT a.thread_id AS origin_id, t.id, t.kind, t.parent_thread_id, 0 AS depth
          FROM actors a JOIN threads t ON t.id = a.thread_id
          UNION ALL
          SELECT chain.origin_id, t.id, t.kind, t.parent_thread_id, chain.depth + 1
          FROM threads t JOIN chain ON t.id = chain.parent_thread_id
          WHERE chain.kind <> 'primary' AND chain.depth < 32
        )
        SELECT t.id AS chat_id, t.title, tw.work_id,
               max(a.at) AS touched_at, bool_or(a.edited) AS edited
        FROM chain
        JOIN actors a ON a.thread_id = chain.origin_id
        JOIN threads t ON t.id = chain.id
        JOIN projects p ON p.id = t.project_id
        LEFT JOIN thread_works tw ON tw.thread_id = t.id AND tw.is_primary
        WHERE chain.kind = 'primary'
          AND t.project_id = ${projectId} AND t.created_by_user_id = ${userId}
          AND t.deleted_at IS NULL AND p.deleted_at IS NULL
        GROUP BY t.id, t.title, tw.work_id
        ORDER BY max(a.at) DESC, t.id DESC
        LIMIT ${limit}
      `);
      return rows.map((row) => ({
        chatId: row.chat_id,
        title: row.title,
        workId: row.work_id,
        touchedAt: new Date(row.touched_at).toISOString(),
        edited: row.edited,
      }));
    },
    async listMentions(documentId) {
      const occurrences = sql<number>`sum(${schema.documentLinks.occurrences})::int`;
      const rows = await currentDrizzleDb(db)
        .select({ targetDocumentId: schema.documentLinks.targetDocumentId, occurrences })
        .from(schema.documentLinks)
        .where(
          and(
            eq(schema.documentLinks.sourceDocumentId, documentId),
            like(schema.documentLinks.linkKey, "doc:%"),
          ),
        )
        .groupBy(schema.documentLinks.targetDocumentId)
        .orderBy(desc(occurrences), schema.documentLinks.targetDocumentId);
      return rows.flatMap((row) =>
        row.targetDocumentId
          ? [{ documentId: row.targetDocumentId, occurrences: row.occurrences }]
          : [],
      );
    },
  };
}
