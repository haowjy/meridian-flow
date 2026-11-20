/**
 * Releases purged documents' content, the one way a document ends for good: its Yjs journal and
 * everything that was only about its text and history. The `documents` row stays, marked
 * `content_purged_at` and stripped of its bytes, so a link bound to it still resolves to "gone".
 * Runs in the caller's transaction, which holds the documents' locks and has closed their drafts;
 * the caller deletes the returned storage objects after the commit.
 */

import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  agentEditWidCounters,
  documentBlockRooms,
  documentEdits,
  documentLinks,
  documentPreviousLocations,
  documents,
  documentYjsHeads,
  observationFrontiers,
  threadDocuments,
  threadShownLinks,
  userRecentDocuments,
} from "@meridian/database/schema";
import { and, inArray, isNull, like, or } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

export type Released = { documentIds: DocumentId[]; storageUrls: string[] };

export async function releaseDocumentContent(
  db: Database,
  documentIds: readonly DocumentId[],
): Promise<Released> {
  if (documentIds.length === 0) return { documentIds: [], storageUrls: [] };
  const tx = currentDrizzleDb(db);
  const held = await tx
    .select({ id: documents.id, storageUrl: documents.storageUrl })
    .from(documents)
    .where(and(inArray(documents.id, [...documentIds]), isNull(documents.contentPurgedAt)));
  const list = held.map(({ id }) => id as DocumentId);
  if (list.length === 0) return { documentIds: [], storageUrls: [] };
  // The head's foreign keys take its checkpoints and updates with it.
  await tx.delete(documentYjsHeads).where(inArray(documentYjsHeads.documentId, list));
  await tx.delete(documentBlockRooms).where(inArray(documentBlockRooms.documentId, list));
  await tx.delete(documentLinks).where(inArray(documentLinks.sourceDocumentId, list));
  // Observation frontiers have no document foreign key; their room key is the only ownership.
  await tx
    .delete(observationFrontiers)
    .where(or(...list.map((id) => like(observationFrontiers.roomKey, `live:${id}:%`))));
  await tx.delete(threadShownLinks).where(inArray(threadShownLinks.documentId, list));
  await tx.delete(threadDocuments).where(inArray(threadDocuments.documentId, list));
  await tx.delete(userRecentDocuments).where(inArray(userRecentDocuments.documentId, list));
  await tx
    .delete(documentPreviousLocations)
    .where(inArray(documentPreviousLocations.documentId, list));
  await tx.delete(agentEditWidCounters).where(inArray(agentEditWidCounters.documentId, list));
  await tx.delete(documentEdits).where(inArray(documentEdits.documentId, list));
  const purgedAt = new Date();
  await tx
    .update(documents)
    .set({
      contentPurgedAt: purgedAt,
      storageUrl: null,
      mimeType: null,
      sizeBytes: null,
      metadata: {},
      updatedAt: purgedAt,
    })
    .where(inArray(documents.id, list));
  return {
    documentIds: list,
    storageUrls: held.flatMap(({ storageUrl }) => (storageUrl ? [storageUrl] : [])),
  };
}
