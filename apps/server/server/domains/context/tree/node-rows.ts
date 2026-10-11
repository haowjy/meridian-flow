/**
 * Node row writes: the one `documents` insert (hidden or live, text or binary), folder
 * inserts, tombstones with their storage release, and document locks in id order. Hidden
 * nodes are tombstoned, never hard-deleted. Every function runs in its caller's transaction.
 */
import type { ContextSourceId, DocumentId, FolderId, ThreadId } from "@meridian/contracts";
import type { JsonObject } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  documentBranches,
  documentDerivations,
  documentLinks,
  documentMarkdownProjections,
  documents,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsReversalOps,
  documentYjsReversals,
  documentYjsUpdates,
  folders,
} from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { renderFilename } from "../context/paths.js";
import type { BinaryNode, TrackedNode } from "./hidden-node-types.js";
import { bumpLocationVersions, claimDocumentLocation } from "./node-locations.js";
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
 * its location. Null when any unique key already holds the row (the caller-minted id; the
 * live location only if the caller skipped its namespace lock and occupancy check).
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
    .set({ deletedAt: new Date() })
    .where(inArray(documents.id, [...ids]));
  await bumpLocationVersions(db, { documentIds: ids });
}

export async function tombstoneFolders(db: Database, ids: readonly FolderId[]): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date();
  await currentDrizzleDb(db)
    .update(folders)
    .set({ deletedAt: now, updatedAt: now })
    .where(inArray(folders.id, [...ids]));
  await bumpLocationVersions(db, { folderIds: ids });
}

/**
 * A tombstoned hidden document's storage goes (R8, contract §12.2 step 4): its live Yjs,
 * every branch on it (their journals and trail rows cascade; by the caller's revalidation
 * no draft uses one), its derived rows and its own outgoing link rows. The row itself and
 * every record pointing at it stay: a bound link or ahead ref still resolves it to gone.
 */
export async function releaseDocumentStorage(
  db: Database,
  ids: readonly DocumentId[],
): Promise<ReleasedBranch[]> {
  if (ids.length === 0) return [];
  const tx = currentDrizzleDb(db);
  const list = [...ids];
  await tx.delete(documentYjsReversalOps).where(inArray(documentYjsReversalOps.documentId, list));
  await tx.delete(documentYjsReversals).where(inArray(documentYjsReversals.documentId, list));
  await tx.delete(agentEditMutations).where(inArray(agentEditMutations.documentId, list));
  await tx.delete(documentYjsHeads).where(inArray(documentYjsHeads.documentId, list));
  await tx.delete(documentYjsCheckpoints).where(inArray(documentYjsCheckpoints.documentId, list));
  await tx.delete(documentYjsUpdates).where(inArray(documentYjsUpdates.documentId, list));
  const branches = await tx
    .delete(documentBranches)
    .where(inArray(documentBranches.documentId, list))
    .returning({
      branchId: documentBranches.id,
      documentId: documentBranches.documentId,
      threadId: documentBranches.threadId,
    });
  await tx.delete(documentDerivations).where(inArray(documentDerivations.documentId, list));
  await tx
    .delete(documentMarkdownProjections)
    .where(inArray(documentMarkdownProjections.documentId, list));
  await tx.delete(documentLinks).where(inArray(documentLinks.sourceDocumentId, list));
  return branches.map((branch) => ({
    branchId: branch.branchId,
    documentId: branch.documentId as DocumentId,
    threadId: branch.threadId as ThreadId | null,
  }));
}

/** A branch a tombstone's release deleted: collab retires its room and thread state after commit. */
export type ReleasedBranch = {
  branchId: string;
  documentId: DocumentId;
  threadId: ThreadId | null;
};
