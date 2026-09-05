/** Per-request Postgres adapter for authoritative internal-link resolution. */

import type { Database } from "@meridian/database";
import {
  contentDocumentPredicate,
  contextSources,
  documents,
  folders,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { type DocumentLinkCandidate, resolveDocumentLink } from "../document-link-resolution.js";
import { documentAliases } from "../document-metadata.js";
import type {
  DocumentLinkResolver,
  ResolveDocumentLinkInput,
} from "../ports/document-link-resolver.js";

type ResolverDb = Pick<Database, "select">;

export function createDrizzleDocumentLinkResolver(db: ResolverDb): DocumentLinkResolver {
  return {
    async resolve(input) {
      return resolveDocumentLink(await loadCandidates(db, input), input);
    },
  };
}

async function loadCandidates(
  db: ResolverDb,
  input: ResolveDocumentLinkInput,
): Promise<DocumentLinkCandidate[]> {
  const rows = await db
    .select({
      documentId: documents.id,
      name: documents.name,
      extension: documents.extension,
      metadata: documents.metadata,
      folderId: documents.folderId,
      sourceId: contextSources.id,
      sourceSlug: contextSources.slug,
      sourceProjectId: contextSources.projectId,
      sourceWorkId: contextSources.workId,
      workProjectId: works.projectId,
    })
    .from(documents)
    .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .where(
      and(
        contentDocumentPredicate(),
        isNull(documents.deletedAt),
        isNull(contextSources.deletedAt),
        or(
          and(
            eq(contextSources.projectId, input.projectId),
            isNull(contextSources.workId),
            eq(contextSources.slug, "manuscript"),
          ),
          and(
            eq(works.projectId, input.projectId),
            isNotNull(contextSources.workId),
            eq(contextSources.slug, "scratch"),
            isNull(works.deletedAt),
          ),
        ),
      ),
    );
  if (rows.length === 0) return [];

  const sourceIds = new Set(rows.map((row) => row.sourceId));
  const folderRows = await db
    .select({
      id: folders.id,
      contextSourceId: folders.contextSourceId,
      parentId: folders.parentId,
      name: folders.name,
    })
    .from(folders)
    .where(and(inArray(folders.contextSourceId, [...sourceIds]), isNull(folders.deletedAt)));
  const folderById = new Map(folderRows.map((folder) => [folder.id, folder]));

  return rows.flatMap((row) => {
    const folderPath = resolveFolderPath(row.folderId, row.sourceId, folderById);
    if (folderPath === null) return [];
    const filename = row.extension ? `${row.name}.${row.extension}` : row.name;
    return [
      {
        projectId: input.projectId,
        documentId: row.documentId,
        title: row.name,
        aliases: documentAliases(row.metadata),
        scheme: row.sourceWorkId ? ("work" as const) : ("manuscript" as const),
        path: [...folderPath, filename].join("/"),
        workId: row.sourceWorkId,
      },
    ];
  });
}

type FolderRow = {
  id: string;
  contextSourceId: string;
  parentId: string | null;
  name: string;
};

function resolveFolderPath(
  folderId: string | null,
  contextSourceId: string,
  foldersById: ReadonlyMap<string, FolderRow>,
): string[] | null {
  const names: string[] = [];
  const visited = new Set<string>();
  let current = folderId;
  while (current) {
    if (visited.has(current)) return null;
    visited.add(current);
    const folder = foldersById.get(current);
    if (!folder || folder.contextSourceId !== contextSourceId) return null;
    names.unshift(folder.name);
    current = folder.parentId;
  }
  return names;
}
