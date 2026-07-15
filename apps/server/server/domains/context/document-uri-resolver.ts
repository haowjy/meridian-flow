/** Resolve persisted document ids back to canonical context URIs. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contentDocumentPredicate,
  contextSources,
  documents,
  folders,
} from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { toCanonical } from "./context/uri.js";
import type { ContextScheme } from "./ports/context-port.js";

export type DocumentUriResolver = (documentId: string) => Promise<string | null>;

type DocumentUriDb = Pick<Database, "select">;

const KNOWN_CONTEXT_SCHEMES = new Set<ContextScheme>([
  "manuscript",
  "kb",
  "scratch",
  "uploads",
  "user",
]);

function asContextScheme(slug: string): ContextScheme | null {
  return KNOWN_CONTEXT_SCHEMES.has(slug as ContextScheme) ? (slug as ContextScheme) : null;
}

export function createDocumentUriResolver(db: DocumentUriDb): DocumentUriResolver {
  return async (documentId) => resolveDocumentUri(db, documentId);
}

export async function resolveDocumentUri(
  db: DocumentUriDb,
  documentId: string,
): Promise<string | null> {
  const [document] = await db
    .select({
      name: documents.name,
      extension: documents.extension,
      folderId: documents.folderId,
      sourceSlug: contextSources.slug,
    })
    .from(documents)
    .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
    .where(
      and(
        eq(documents.id, documentId as DocumentId),
        contentDocumentPredicate(),
        isNull(documents.deletedAt),
        isNull(contextSources.deletedAt),
      ),
    )
    .limit(1);
  if (!document) return null;

  const scheme = asContextScheme(document.sourceSlug);
  if (!scheme) return null;

  const folderPath = await resolveFolderPath(db, document.folderId);
  const filename = document.extension ? `${document.name}.${document.extension}` : document.name;
  const path = [...folderPath, filename].join("/");
  return toCanonical(scheme, path);
}

async function resolveFolderPath(db: DocumentUriDb, folderId: string | null): Promise<string[]> {
  const names: string[] = [];
  let current = folderId;
  while (current !== null) {
    const [folder] = await db
      .select({ id: folders.id, parentId: folders.parentId, name: folders.name })
      .from(folders)
      .where(eq(folders.id, current as typeof folders.$inferSelect.id))
      .limit(1);
    if (!folder) break;
    if (folder.name) names.unshift(folder.name);
    current = folder.parentId;
  }
  return names;
}
