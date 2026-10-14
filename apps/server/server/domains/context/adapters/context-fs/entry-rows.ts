/**
 * Row creation shared by singleton and sibling-batch Context creation: the opposite-kind
 * conflict check, the insert and the location claim are one policy. The caller holds the
 * source's namespace lock and owns catalog publication, membership and seeding.
 */
import { type Filetype, renderFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";
import type { DocumentCreationMetadata } from "../../document-metadata.js";
import { ContextEntryConflictError } from "../../ports/context-document-store.js";
import { claimDocumentLocation, hasOppositeContextEntry } from "./document-locations.js";

/** `ifAbsent` swallows a same-name row (returning null); otherwise the unique index throws. */
type CreateMode = { ifAbsent: boolean };

export async function createFolderRow(
  db: Database,
  input: { id?: string; sourceId: string; parentId: string | null; name: string },
  { ifAbsent }: CreateMode,
): Promise<typeof folders.$inferSelect | null> {
  const { sourceId, parentId, name } = input;
  if (await hasOppositeContextEntry(db, sourceId, parentId, name, "folder"))
    throw new ContextEntryConflictError("file");
  const insert = currentDrizzleDb(db)
    .insert(folders)
    .values({ id: input.id, contextSourceId: sourceId, parentId, name });
  const [row] = await (ifAbsent ? insert.onConflictDoNothing() : insert).returning();
  if (!row) return null;
  await claimDocumentLocation(db, sourceId, parentId, name);
  return row;
}

export async function createDocumentRow(
  db: Database,
  input: {
    id?: string;
    sourceId: string;
    folderId: string | null;
    name: string;
    extension: string;
    filetype: Filetype;
    markdown: string;
    provisionalName?: boolean;
    metadata?: DocumentCreationMetadata;
  },
  { ifAbsent }: CreateMode,
): Promise<typeof documents.$inferSelect | null> {
  const { sourceId, folderId, name, extension } = input;
  const filename = renderFilename(name, extension);
  if (await hasOppositeContextEntry(db, sourceId, folderId, filename, "file"))
    throw new ContextEntryConflictError("folder");
  const insert = currentDrizzleDb(db)
    .insert(documents)
    .values({
      id: input.id,
      contextSourceId: sourceId,
      folderId,
      name,
      extension,
      fileType: input.filetype,
      markdownProjection: input.markdown,
      sizeBytes: Buffer.byteLength(input.markdown, "utf8"),
      ...(input.provisionalName === undefined ? {} : { provisionalName: input.provisionalName }),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  const [row] = await (ifAbsent ? insert.onConflictDoNothing() : insert).returning();
  if (!row) return null;
  await claimDocumentLocation(db, sourceId, folderId, filename);
  return row;
}
