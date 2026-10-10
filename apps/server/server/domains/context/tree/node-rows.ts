/**
 * Row writes the hidden-node lifecycle shares: folder inserts, tombstones, and document
 * locks in id order. Hidden nodes are tombstoned, never hard-deleted. Every function runs
 * in its caller's transaction.
 */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { renderFilename } from "../context/paths.js";

/** A document's source-relative path from its folder names and stored name. */
export function filePath(dir: readonly string[], name: string, extension: string): string {
  return [...dir, renderFilename(name, extension)].join("/");
}

/** Document mutation locks, once each, in id order. */
export async function lockDocuments(db: Database, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockDocumentMutation(currentDrizzleDb(db), id);
}

export async function insertFolder(
  db: Database,
  at: { contextSourceId: ContextSourceId; parentId: FolderId | null; name: string },
  options: { hidden: boolean },
): Promise<FolderId> {
  const [row] = await currentDrizzleDb(db)
    .insert(folders)
    .values({
      contextSourceId: at.contextSourceId,
      parentId: at.parentId,
      name: at.name,
      hidden: options.hidden,
    })
    .returning({ id: folders.id });
  if (!row) throw new Error(`Folder ${at.name} was not inserted`);
  return row.id;
}

export async function tombstoneDocuments(db: Database, ids: readonly DocumentId[]): Promise<void> {
  if (ids.length === 0) return;
  await currentDrizzleDb(db)
    .update(documents)
    .set({ deletedAt: new Date(), locationVersion: sql`${documents.locationVersion} + 1` })
    .where(inArray(documents.id, [...ids]));
}

export async function tombstoneFolder(db: Database, id: FolderId): Promise<void> {
  await currentDrizzleDb(db)
    .update(folders)
    .set({ deletedAt: new Date(), locationVersion: sql`${folders.locationVersion} + 1` })
    .where(eq(folders.id, id));
}
