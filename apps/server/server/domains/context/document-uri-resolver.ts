/** Resolve persisted document ids back to canonical context URIs. */
import { isContextUriScheme } from "@meridian/contracts/context-uri";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contentDocumentPredicate,
  contextSources,
  documents,
  folders,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ProjectWorkAuthorityResolver } from "../projects/index.js";
import { toCanonical } from "./context/uri.js";
import type { ContextScheme } from "./ports/context-port.js";

export type DocumentUriResolver = (documentId: string) => Promise<string | null>;

type DocumentUriDb = Pick<Database, "select">;

function asContextScheme(slug: string): ContextScheme | null {
  return isContextUriScheme(slug) ? slug : null;
}

export function createDocumentUriResolver(
  db: DocumentUriDb,
  workAuthorityResolver: ProjectWorkAuthorityResolver,
): DocumentUriResolver {
  return async (documentId) => resolveDocumentUri(db, workAuthorityResolver, documentId);
}

export async function resolveDocumentUri(
  db: DocumentUriDb,
  workAuthorityResolver: ProjectWorkAuthorityResolver,
  documentId: string,
): Promise<string | null> {
  return (
    (await resolveDocumentUris(db, workAuthorityResolver, [documentId])).get(documentId) ?? null
  );
}

export type DocumentUrisResolver = (
  documentIds: readonly string[],
) => Promise<ReadonlyMap<string, string | null>>;

export function createDocumentUrisResolver(
  db: DocumentUriDb,
  workAuthorityResolver: ProjectWorkAuthorityResolver,
): DocumentUrisResolver {
  return (documentIds) => resolveDocumentUris(db, workAuthorityResolver, documentIds);
}

export async function resolveDocumentUris(
  db: DocumentUriDb,
  workAuthorityResolver: ProjectWorkAuthorityResolver,
  documentIds: readonly string[],
): Promise<ReadonlyMap<string, string | null>> {
  const result = new Map<string, string | null>(documentIds.map((id) => [id, null]));
  if (!documentIds.length) return result;
  const rows = await db
    .select({
      id: documents.id,
      name: documents.name,
      extension: documents.extension,
      folderId: documents.folderId,
      sourceId: documents.contextSourceId,
      sourceSlug: contextSources.slug,
      workId: works.id,
      workProjectId: works.projectId,
    })
    .from(documents)
    .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
    .leftJoin(works, eq(works.id, contextSources.workId))
    .where(
      and(
        inArray(documents.id, documentIds as DocumentId[]),
        contentDocumentPredicate(),
        isNull(documents.deletedAt),
        isNull(contextSources.deletedAt),
      ),
    );
  if (!rows.length) return result;
  const folderRows = await db
    .select({ id: folders.id, parentId: folders.parentId, name: folders.name })
    .from(folders)
    .where(inArray(folders.contextSourceId, [...new Set(rows.map((row) => row.sourceId))]));
  const folderById = new Map(folderRows.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string[]>();
  const folderPath = (id: string | null, visiting = new Set<string>()): string[] => {
    if (!id) return [];
    const cached = paths.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new Error("Cyclic document folder graph");
    const folder = folderById.get(id as typeof folders.$inferSelect.id);
    if (!folder) return [];
    visiting.add(id);
    const path = [...folderPath(folder.parentId, visiting), ...(folder.name ? [folder.name] : [])];
    visiting.delete(id);
    paths.set(id, path);
    return path;
  };
  const authorities = new Map<string, ReturnType<ProjectWorkAuthorityResolver["byId"]>>();
  await Promise.all(
    rows.map(async (document) => {
      const scheme = asContextScheme(document.sourceSlug);
      if (!scheme) return;
      let authority:
        | Awaited<ReturnType<ProjectWorkAuthorityResolver["byId"]>>
        | { kind: "contextual" };
      if (scheme === "scratch" || scheme === "uploads") {
        if (!document.workId || !document.workProjectId) return;
        let pending = authorities.get(document.workId);
        if (!pending) {
          pending = workAuthorityResolver.byId(document.workProjectId, document.workId);
          authorities.set(document.workId, pending);
        }
        authority = await pending;
      } else authority = { kind: "contextual" as const };
      if (!authority) return;
      const filename = document.extension
        ? `${document.name}.${document.extension}`
        : document.name;
      result.set(
        document.id,
        toCanonical(scheme, [...folderPath(document.folderId), filename].join("/"), authority),
      );
    }),
  );
  return result;
}
