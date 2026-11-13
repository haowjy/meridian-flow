/**
 * Releases a purged document's content: its Yjs journal and everything that was only about its
 * text and history. The `documents` row stays (marked by the caller), so a link bound to it
 * still resolves to "gone". Runs in the caller's transaction, which holds the document's lock.
 */
import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  agentEditWidCounters,
  applyCommandEffects,
  documentBlockRooms,
  documentDrafts,
  documentEdits,
  documentLinks,
  documentPreviousLocations,
  documentYjsHeads,
  observationFrontiers,
  threadDocuments,
  threadShownLinks,
  userRecentDocuments,
} from "@meridian/database/schema";
import { inArray, like, or } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

export async function releaseDocumentContent(
  db: Database,
  ids: readonly DocumentId[],
): Promise<void> {
  if (ids.length === 0) return;
  const tx = currentDrizzleDb(db);
  const list = [...ids];
  // The head's foreign keys take its checkpoints and updates with it.
  await tx.delete(documentYjsHeads).where(inArray(documentYjsHeads.documentId, list));
  const drafts = await tx
    .select({ draftId: documentDrafts.id })
    .from(documentDrafts)
    .where(inArray(documentDrafts.documentId, list));
  await tx.delete(documentBlockRooms).where(inArray(documentBlockRooms.documentId, list));
  await tx.delete(documentLinks).where(inArray(documentLinks.sourceDocumentId, list));
  // Observation frontiers have no document foreign key; their room key is the only ownership.
  await tx
    .delete(observationFrontiers)
    .where(
      or(
        ...list.map((id) => like(observationFrontiers.roomKey, `live:${id}:%`)),
        ...drafts.map(({ draftId }) => like(observationFrontiers.roomKey, `draft:${draftId}`)),
      ),
    );
  await tx.delete(applyCommandEffects).where(inArray(applyCommandEffects.documentId, list));
  await tx.delete(threadShownLinks).where(inArray(threadShownLinks.documentId, list));
  await tx.delete(threadDocuments).where(inArray(threadDocuments.documentId, list));
  await tx.delete(userRecentDocuments).where(inArray(userRecentDocuments.documentId, list));
  await tx
    .delete(documentPreviousLocations)
    .where(inArray(documentPreviousLocations.documentId, list));
  await tx.delete(agentEditWidCounters).where(inArray(agentEditWidCounters.documentId, list));
  await tx.delete(documentEdits).where(inArray(documentEdits.documentId, list));
  await tx.delete(documentDrafts).where(inArray(documentDrafts.documentId, list));
}
