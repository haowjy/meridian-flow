/**
 * Node row writes: the one `documents` insert (hidden or live, text or binary), folder
 * inserts, tombstones with their storage release, and document locks in id order. Hidden
 * nodes are tombstoned, never hard-deleted. Every function runs in its caller's transaction.
 */
import type { ContextSourceId, DocumentId, FolderId, ThreadId, UserId } from "@meridian/contracts";
import { type DocumentRemovalCause, folderDocumentName } from "@meridian/contracts/protocol";
import type { JsonObject } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import {
  agentEditWidCounters,
  applyCommandEffects,
  changeTrailDocumentDetails,
  documentDerivations,
  documentDrafts,
  documentEdits,
  documentForwards,
  documentLinks,
  documentMarkdownProjections,
  documentPreviousLocations,
  documents,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
  draftWriteJournal,
  folders,
  observationFrontiers,
  pushLineage,
  threadDocuments,
  threadShownLinks,
  turnDocumentTouches,
  userRecentDocuments,
} from "@meridian/database/schema";
import { inArray, like, or } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { renderFilename } from "../context/paths.js";
import type { BinaryNode, TrackedNode } from "./hidden-node-types.js";
import { normalizeNames } from "./name-normalization.js";
import { bumpLocationVersions, claimDocumentLocation } from "./node-locations.js";
import { placeLiveSibling } from "./sibling-order.js";
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
    await normalizeNames(db, [{ kind: "document", id: row.id }]);
    await placeLiveSibling(db, {
      node: { kind: "document", id: row.id },
      sourceId: slot.contextSourceId,
      parentId: slot.folderId,
      arrived: true,
    });
  }
  return row.id;
}

export async function insertFolder(
  db: Database,
  at: { contextSourceId: ContextSourceId; parentId: FolderId | null; name: string },
  options: { hidden: boolean; id?: FolderId; orderPolicy?: "default" | "manual" },
): Promise<FolderId> {
  const [row] = await currentDrizzleDb(db)
    .insert(folders)
    .values({
      ...(options.id ? { id: options.id } : {}),
      contextSourceId: at.contextSourceId,
      parentId: at.parentId,
      name: at.name,
      documentAlias: folderDocumentName(at.name),
      hidden: options.hidden,
      ...(options.orderPolicy ? { orderPolicy: options.orderPolicy } : {}),
    })
    .returning({ id: folders.id });
  if (!row) throw new Error(`Folder ${at.name} was not inserted`);
  if (!options.hidden)
    await placeLiveSibling(db, {
      node: { kind: "folder", id: row.id },
      sourceId: at.contextSourceId,
      parentId: at.parentId,
      arrived: true,
    });
  return row.id;
}

export type RemovalInitiator =
  | { userId: UserId }
  | { threadId: ThreadId }
  | { cause: DocumentRemovalCause };

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
 * Releases a tombstoned document's byte stores. Discard retains non-byte history; permanent
 * trash purge removes document-owned histories too. The row and incoming identity links stay,
 * so a bound link still resolves the tombstone to gone.
 */
export async function releaseDocumentStorage(
  db: Database,
  ids: readonly DocumentId[],
  options: { retainHistory?: boolean } = {},
): Promise<void> {
  if (ids.length === 0) return;
  const tx = currentDrizzleDb(db);
  const list = [...ids];
  await tx.delete(documentYjsHeads).where(inArray(documentYjsHeads.documentId, list));
  await tx.delete(documentYjsCheckpoints).where(inArray(documentYjsCheckpoints.documentId, list));
  await tx.delete(documentYjsUpdates).where(inArray(documentYjsUpdates.documentId, list));
  const drafts = await tx
    .select({ draftId: documentDrafts.id, status: documentDrafts.status })
    .from(documentDrafts)
    .where(inArray(documentDrafts.documentId, list));
  await tx.delete(documentDerivations).where(inArray(documentDerivations.documentId, list));
  await tx
    .delete(documentMarkdownProjections)
    .where(inArray(documentMarkdownProjections.documentId, list));
  await tx.delete(documentLinks).where(inArray(documentLinks.sourceDocumentId, list));
  if (options.retainHistory !== false) {
    const closedDraftIds = drafts
      .filter((row) => row.status === "closed")
      .map((row) => row.draftId);
    if (closedDraftIds.length) {
      await tx.delete(draftWriteJournal).where(inArray(draftWriteJournal.draftId, closedDraftIds));
      await tx
        .update(documentDrafts)
        .set({
          state: Buffer.alloc(0),
          stateVector: Buffer.alloc(0),
        })
        .where(inArray(documentDrafts.id, closedDraftIds));
    }
    return;
  }

  const draftIds = drafts.map((row) => row.draftId);
  // Observation frontiers intentionally have no document FK. Their stable room-key format is
  // the only ownership index for snapshots whose source document is now being purged.
  await tx
    .delete(observationFrontiers)
    .where(
      or(
        ...list.map((id) => like(observationFrontiers.roomKey, `live:${id}:%`)),
        ...draftIds.map((id) => like(observationFrontiers.roomKey, `draft:${id}`)),
      ),
    );
  await tx.delete(applyCommandEffects).where(inArray(applyCommandEffects.documentId, list));
  await tx
    .delete(changeTrailDocumentDetails)
    .where(inArray(changeTrailDocumentDetails.documentId, list));
  await tx.delete(pushLineage).where(inArray(pushLineage.documentId, list));
  await tx.delete(threadShownLinks).where(inArray(threadShownLinks.documentId, list));
  await tx.delete(threadDocuments).where(inArray(threadDocuments.documentId, list));
  await tx.delete(turnDocumentTouches).where(inArray(turnDocumentTouches.documentId, list));
  await tx.delete(userRecentDocuments).where(inArray(userRecentDocuments.documentId, list));
  await tx
    .delete(documentPreviousLocations)
    .where(inArray(documentPreviousLocations.documentId, list));
  await tx.delete(documentForwards).where(inArray(documentForwards.toDocumentId, list));
  await tx.delete(agentEditWidCounters).where(inArray(agentEditWidCounters.documentId, list));
  await tx.delete(documentEdits).where(inArray(documentEdits.documentId, list));
  await tx.delete(documentDrafts).where(inArray(documentDrafts.documentId, list));
}
