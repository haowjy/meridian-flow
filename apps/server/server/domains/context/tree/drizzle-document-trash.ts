/** Drizzle adapter for restorable document trash and permanent content purge. */
import { type DocumentId, type ProjectId, serializeRemovalIdentity } from "@meridian/contracts";
import type { DocumentTrashEntry, GetDocumentTrashResponse } from "@meridian/contracts/protocol";
import { deletionPurgeAt, deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import {
  branches,
  contextSources,
  documentMarkdownProjections,
  documents,
  projects,
  works,
} from "@meridian/database/schema";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import { createObjectRelease, type ObjectStorePort } from "../../storage/index.js";
import type { DocumentPurgeDraftDisposal, DocumentTrash } from "../ports/document-trash.js";
import { releaseDocumentStorage } from "./node-rows.js";
import { readRemovalRecords } from "./removal.js";
import { loadDocumentAddresses } from "./tree-addresses.js";
import { pendingDocuments } from "./tree-view-sql.js";

const DOCUMENT_PURGE_BATCH_LIMIT = 100;
const sourceProjects = alias(projects, "document_trash_source_projects");
const requestProjects = alias(projects, "document_trash_request_projects");

/** The one lifecycle gate shared by trash reads and both stages of purge. */
function trashEligible() {
  return sql<boolean>`${isNotNull(documents.deletedAt)}
    AND ${eq(documents.deletionReason, "deleted")}
    AND ${eq(documents.hidden, false)}
    AND ${isNull(documents.deletedByWorkId)}
    AND ${isNull(documents.contentPurgedAt)}
    AND ${isNull(contextSources.deletedAt)}
    AND ${isNull(sourceProjects.deletedAt)}`;
}

/** A project owns its own sources plus its account's personal user:// source. */
function projectTrashMember() {
  return sql<boolean>`(${eq(sourceProjects.id, requestProjects.id)}
    OR (${eq(contextSources.slug, "user")}
      AND ${eq(sourceProjects.userId, requestProjects.userId)}))`;
}

export function createDrizzleDocumentTrash(deps: {
  db: Database;
  objectStore: ObjectStorePort;
  eventSink: EventSink;
  drafts: DocumentPurgeDraftDisposal;
}): DocumentTrash {
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

  const rows = async (projectId: ProjectId, documentId?: DocumentId) => {
    const tx = currentDrizzleDb(deps.db);
    return tx
      .select({
        documentId: documents.id,
        name: documents.name,
        extension: documents.extension,
        deletedAt: sql<Date>`${documents.deletedAt}`.mapWith(documents.deletedAt),
        locationVersion: documents.locationVersion,
      })
      .from(documents)
      .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
      .leftJoin(works, eq(works.id, contextSources.workId))
      .innerJoin(
        sourceProjects,
        eq(sourceProjects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
      )
      .innerJoin(requestProjects, eq(requestProjects.id, projectId))
      .where(
        and(
          projectTrashMember(),
          isNull(requestProjects.deletedAt),
          documentId ? eq(documents.id, documentId) : undefined,
          trashEligible(),
        ),
      )
      .orderBy(desc(documents.deletedAt), desc(documents.id));
  };

  const entries = async (
    result: Awaited<ReturnType<typeof rows>>,
  ): Promise<DocumentTrashEntry[]> => {
    const tx = currentDrizzleDb(deps.db);
    const ids = result.map(({ documentId }) => documentId as DocumentId);
    const [addresses, removals] = await Promise.all([
      loadDocumentAddresses(deps.db, { ids }),
      readRemovalRecords(tx, ids),
    ]);
    const held = new Map<DocumentId, Array<{ id: string; name: string }>>();
    if (ids.length) {
      const pending = await tx.execute<{ document_id: string; id: string; name: string }>(sql`
        SELECT DISTINCT p.document_id::text, w.id::text, w.name
        FROM (${pendingDocuments(
          sql`SELECT ${branches.id} FROM ${branches} WHERE ${branches.status} = 'active'`,
        )}) p
        JOIN ${branches} b ON b.id = p.branch_id
        JOIN ${works} w ON w.id = b.origin_work_id
        WHERE p.document_id IN (${sql.join(ids, sql`, `)})
        ORDER BY p.document_id::text, w.name, w.id::text
      `);
      for (const row of pending) {
        const documentId = row.document_id as DocumentId;
        const retaining = held.get(documentId) ?? [];
        retaining.push({ id: row.id, name: row.name });
        held.set(documentId, retaining);
      }
    }
    const addressesById = new Map(addresses.map((address) => [address.documentId, address]));

    return result.flatMap((row): DocumentTrashEntry[] => {
      const documentId = row.documentId as DocumentId;
      const address = addressesById.get(documentId);
      const record = removals.get(documentId);
      if (!address || !record || !row.deletedAt) return [];
      return [
        {
          documentId,
          name: row.extension ? `${row.name}.${row.extension}` : row.name,
          scheme: address.scheme,
          formerPath: address.path,
          removal: serializeRemovalIdentity({
            time: row.deletedAt,
            locationVersion: row.locationVersion,
          }),
          actor: record.actor,
          retention: held.has(documentId)
            ? { kind: "held", works: held.get(documentId) ?? [] }
            : { kind: "scheduled", purgeAt: deletionPurgeAt(row.deletedAt).toISOString() },
        },
      ];
    });
  };

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
            eligible: trashEligible(),
          })
          .from(documents)
          .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
          .leftJoin(works, eq(works.id, contextSources.workId))
          .innerJoin(
            sourceProjects,
            eq(sourceProjects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
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
        const purgedAt = new Date();
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
    async retained(projectId, documentIds): Promise<ReadonlySet<DocumentId>> {
      if (documentIds.length === 0) return new Set();
      const rows = await currentDrizzleDb(deps.db)
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
        .leftJoin(works, eq(works.id, contextSources.workId))
        .innerJoin(
          sourceProjects,
          eq(sourceProjects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
        )
        .innerJoin(requestProjects, eq(requestProjects.id, projectId))
        .where(
          and(
            inArray(documents.id, documentIds),
            projectTrashMember(),
            isNull(requestProjects.deletedAt),
            trashEligible(),
          ),
        );
      return new Set(rows.map(({ id }) => id as DocumentId));
    },
    async list(projectId): Promise<readonly DocumentTrashEntry[]> {
      return entries(await rows(projectId));
    },
    async read(projectId, documentId): Promise<GetDocumentTrashResponse | null> {
      const entry = (await entries(await rows(projectId, documentId)))[0];
      if (!entry) return null;
      const [projection] = await currentDrizzleDb(deps.db)
        .select({ markdown: documentMarkdownProjections.markdown })
        .from(documentMarkdownProjections)
        .where(eq(documentMarkdownProjections.documentId, documentId))
        .limit(1);
      return { ...entry, markdown: projection?.markdown ?? "" };
    },
    async wasPurged(projectId, documentId): Promise<boolean> {
      const [row] = await currentDrizzleDb(deps.db)
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
        .leftJoin(works, eq(works.id, contextSources.workId))
        .innerJoin(
          sourceProjects,
          eq(sourceProjects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
        )
        .innerJoin(requestProjects, eq(requestProjects.id, projectId))
        .where(
          and(
            eq(documents.id, documentId),
            projectTrashMember(),
            isNull(requestProjects.deletedAt),
            isNotNull(documents.contentPurgedAt),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
    async purge(): Promise<number> {
      const cutoff = deletionPurgeCutoff(new Date());
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
            sourceProjects,
            eq(sourceProjects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
          )
          .where(
            and(
              lte(documents.deletedAt, cutoff),
              trashEligible(),
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
