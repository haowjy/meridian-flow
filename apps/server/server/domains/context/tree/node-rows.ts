/**
 * Node row writes: the one `documents` insert (hidden or live, text or binary), folder
 * inserts, tombstones, and document locks in id order. Hidden nodes are tombstoned, never
 * hard-deleted. Every function runs in its caller's transaction.
 */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { JsonObject } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { documentMarkdownProjections, documents, folders } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { claimDocumentLocation } from "../adapters/context-fs/document-locations.js";
import { renderFilename } from "../context/paths.js";
import type { BinaryNode, TrackedNode } from "./hidden-node-types.js";
import type { DocumentSlot } from "./tree-view-sql.js";

/** A document's source-relative path from its folder names and stored name. */
export function filePath(dir: readonly string[], name: string, extension: string): string {
  return [...dir, renderFilename(name, extension)].join("/");
}

/** Document mutation locks, once each, in id order. */
export async function lockDocuments(db: Database, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockDocumentMutation(currentDrizzleDb(db), id);
}

/**
 * A document row at `slot`: a text row with its Markdown projection (`markdown`, empty by
 * default; a hidden row's is always empty), or a storage-backed row. A visible row claims
 * its location. Null when a unique key (a caller-minted id) already holds the row.
 */
export async function insertDocumentRow(
  db: Database,
  slot: DocumentSlot,
  node: TrackedNode | BinaryNode,
  options: { hidden: boolean; id?: DocumentId; markdown?: string; provisionalName?: boolean },
): Promise<DocumentId | null> {
  const tx = currentDrizzleDb(db);
  const markdown = options.markdown ?? "";
  const [row] = await tx
    .insert(documents)
    .values({
      ...(options.id ? { id: options.id } : {}),
      contextSourceId: slot.contextSourceId,
      folderId: slot.folderId,
      name: slot.name,
      extension: slot.extension,
      hidden: options.hidden,
      ...(node.kind === "tracked"
        ? { fileType: node.filetype, sizeBytes: Buffer.byteLength(markdown, "utf8") }
        : {
            fileType: node.fileType,
            storageUrl: node.storageUrl,
            mimeType: node.mimeType,
            sizeBytes: node.sizeBytes,
          }),
      ...(options.provisionalName ? { provisionalName: true } : {}),
      ...(node.metadata ? { metadata: node.metadata as JsonObject } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: documents.id });
  if (!row) return null;
  if (node.kind === "tracked") {
    await tx.insert(documentMarkdownProjections).values({ documentId: row.id, markdown });
  }
  if (!options.hidden) {
    await claimDocumentLocation(
      db,
      slot.contextSourceId,
      slot.folderId,
      renderFilename(slot.name, slot.extension),
    );
  }
  return row.id;
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
