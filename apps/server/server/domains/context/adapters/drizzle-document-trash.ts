/** Expired document-trash content purge; tombstone identity and incoming links remain. */
import type { DocumentId } from "@meridian/contracts";
import { deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import { branches, contextSources, documents, projects, works } from "@meridian/database/schema";
import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import { createObjectRelease, type ObjectStorePort } from "../../storage/index.js";
import type { DocumentPurgeDraftDisposal, DocumentTrash } from "../ports/document-trash.js";
import { releaseDocumentStorage } from "../tree/node-rows.js";
import { pendingDocuments } from "../tree/tree-view-sql.js";

const DOCUMENT_PURGE_BATCH_LIMIT = 100;

export function createDrizzleDocumentTrash(deps: {
  db: Database;
  objectStore: ObjectStorePort;
  eventSink: EventSink;
  drafts: DocumentPurgeDraftDisposal;
  now?: () => Date;
}): DocumentTrash {
  const now = deps.now ?? (() => new Date());
  const objects = createObjectRelease({
    objectStore: deps.objectStore,
    onFailure(key, error) {
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "context.document-purge",
        name: "object_delete.failed",
        payload: { key, error },
      });
    },
  });

  async function purgeOne(
    documentId: DocumentId,
    cutoff: Date,
  ): Promise<{ purged: boolean; storageUrl: string | null }> {
    return deps.drafts.withDisposal(documentId, (disposeDrafts) =>
      runInDrizzleTransaction(deps.db, async () => {
        const tx = currentDrizzleDb(deps.db);
        const [row] = await tx
          .select({
            deletedAt: documents.deletedAt,
            storageUrl: documents.storageUrl,
            eligible: sql<boolean>`${documents.deletionReason} = 'deleted'
              AND NOT ${documents.hidden}
              AND ${documents.deletedByWorkId} IS NULL
              AND ${documents.contentPurgedAt} IS NULL
              AND ${contextSources.deletedAt} IS NULL
              AND ${projects.deletedAt} IS NULL`,
          })
          .from(documents)
          .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
          .leftJoin(works, eq(works.id, contextSources.workId))
          .innerJoin(
            projects,
            eq(projects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
          )
          .where(eq(documents.id, documentId));
        if (!row?.eligible || !row.deletedAt || row.deletedAt.getTime() > cutoff.getTime()) {
          return { purged: false, storageUrl: null };
        }

        const [pending] = await tx.execute<{ pending: boolean }>(sql`
          SELECT EXISTS (
            SELECT 1 FROM (${pendingDocuments(
              sql`SELECT ${branches.id} FROM ${branches} WHERE ${branches.status} = 'active'`,
              documentId,
            )}) pending
          ) AS pending
        `);
        if (pending?.pending) return { purged: false, storageUrl: null };

        await disposeDrafts();
        await releaseDocumentStorage(deps.db, [documentId], { retainHistory: false });
        const purgedAt = now();
        const updated = await tx
          .update(documents)
          .set({
            contentPurgedAt: purgedAt,
            storageUrl: null,
            mimeType: null,
            sizeBytes: null,
            description: null,
            metadata: {},
            updatedAt: purgedAt,
          })
          .where(
            and(
              eq(documents.id, documentId),
              isNull(documents.contentPurgedAt),
              lte(documents.deletedAt, cutoff),
            ),
          )
          .returning({ id: documents.id });
        return { purged: updated.length > 0, storageUrl: row.storageUrl };
      }),
    );
  }

  return {
    async purge(): Promise<number> {
      const cutoff = deletionPurgeCutoff(now());
      let count = 0;
      let after: { id: DocumentId; deletedAt: Date } | undefined;
      while (count < DOCUMENT_PURGE_BATCH_LIMIT) {
        const candidates = await currentDrizzleDb(deps.db)
          .select({
            id: documents.id,
            deletedAt: sql<Date>`${documents.deletedAt}`.mapWith(documents.deletedAt),
          })
          .from(documents)
          .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
          .leftJoin(works, eq(works.id, contextSources.workId))
          .innerJoin(
            projects,
            eq(projects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
          )
          .where(
            and(
              isNotNull(documents.deletedAt),
              lte(documents.deletedAt, cutoff),
              eq(documents.deletionReason, "deleted"),
              eq(documents.hidden, false),
              isNull(documents.deletedByWorkId),
              isNull(documents.contentPurgedAt),
              isNull(contextSources.deletedAt),
              isNull(projects.deletedAt),
              after
                ? or(
                    gt(documents.deletedAt, after.deletedAt),
                    and(eq(documents.deletedAt, after.deletedAt), gt(documents.id, after.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(documents.deletedAt), asc(documents.id))
          .limit(DOCUMENT_PURGE_BATCH_LIMIT - count);
        after = candidates.at(-1);
        if (!after) break;
        for (const candidate of candidates) {
          const result = await purgeOne(candidate.id, cutoff);
          if (!result.purged) continue;
          count += 1;
          if (result.storageUrl) await objects.storageUrls([result.storageUrl]);
        }
      }
      return count;
    },
  };
}
