/** Drizzle reader for a project's current restorable document tombstones. */
import { type DocumentId, type ProjectId, serializeRemovalIdentity } from "@meridian/contracts";
import type { DocumentTrashEntry, GetDocumentTrashResponse } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documentMarkdownProjections,
  documents,
  projects,
  works,
} from "@meridian/database/schema";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentTrash } from "../ports/document-trash.js";
import { readRemovalRecords } from "../tree/removal.js";
import { loadDocumentAddresses } from "../tree/tree-addresses.js";

const DOCUMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function createDrizzleDocumentTrash(db: Database): DocumentTrash {
  const rows = async (projectId: ProjectId, documentId?: DocumentId) => {
    const tx = currentDrizzleDb(db);
    return tx
      .select({
        documentId: documents.id,
        name: documents.name,
        extension: documents.extension,
        deletedAt: sql<Date>`${documents.deletedAt}`.mapWith(documents.deletedAt),
        locationVersion: documents.locationVersion,
        markdown: documentMarkdownProjections.markdown,
      })
      .from(documents)
      .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
      .leftJoin(works, eq(works.id, contextSources.workId))
      .innerJoin(
        projects,
        eq(projects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
      )
      .leftJoin(
        documentMarkdownProjections,
        eq(documentMarkdownProjections.documentId, documents.id),
      )
      .where(
        and(
          eq(projects.id, projectId),
          documentId ? eq(documents.id, documentId) : undefined,
          isNotNull(documents.deletedAt),
          eq(documents.deletionReason, "deleted"),
          eq(documents.hidden, false),
          isNull(documents.deletedByWorkId),
          isNull(contextSources.deletedAt),
          isNull(projects.deletedAt),
        ),
      )
      .orderBy(desc(documents.deletedAt), desc(documents.id));
  };

  const entries = async (
    result: Awaited<ReturnType<typeof rows>>,
  ): Promise<Array<GetDocumentTrashResponse>> => {
    const tx = currentDrizzleDb(db);
    const ids = result.map(({ documentId }) => documentId as DocumentId);
    const [addresses, removals] = await Promise.all([
      loadDocumentAddresses(db, { ids }),
      readRemovalRecords(tx, ids),
    ]);
    const addressesById = new Map(addresses.map((address) => [address.documentId, address]));

    return result.flatMap((row): GetDocumentTrashResponse[] => {
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
          deletedAt: record.time,
          purgeAt: new Date(row.deletedAt.getTime() + DOCUMENT_RETENTION_MS).toISOString(),
          markdown: row.markdown ?? "",
        },
      ];
    });
  };

  return {
    async list(projectId): Promise<readonly DocumentTrashEntry[]> {
      return (await entries(await rows(projectId))).map(
        ({ markdown: _markdown, ...entry }) => entry,
      );
    },
    async read(projectId, documentId): Promise<GetDocumentTrashResponse | null> {
      return (await entries(await rows(projectId, documentId)))[0] ?? null;
    },
  };
}
