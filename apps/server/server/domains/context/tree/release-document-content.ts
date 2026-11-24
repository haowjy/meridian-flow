/**
 * Releases purged documents' content, the one way a document ends for good: its rooms' snapshots
 * and everything that was only about its text and history. The `documents` row stays, marked
 * `content_purged_at` and stripped of its bytes, so a link bound to it still resolves to "gone".
 * Runs in the caller's transaction, which has closed their drafts. It takes the documents' locks
 * itself: a snapshot write reads `content_purged_at` under the same lock and writes nothing for a
 * purged document, so a save waiting on those locks cannot bring the content back; the loaded rooms end after the commit, and the caller deletes the
 * returned storage objects then too.
 */

import type { DocumentId } from "@meridian/contracts";
import { loroRoomName } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  agentEditWidCounters,
  documentBlockRooms,
  documentEdits,
  documentForks,
  documentLinks,
  documentPreviousLocations,
  documentSnapshots,
  documents,
  observationFrontiers,
  threadDocuments,
  threadShownLinks,
  userRecentDocuments,
} from "@meridian/database/schema";
import { and, inArray, isNull } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";

const liveRoomKey = (documentId: DocumentId) => loroRoomName({ kind: "live", documentId });

export type Released = { documentIds: DocumentId[]; storageUrls: string[] };

export async function releaseDocumentContent(
  db: Database,
  /** Collab's `endDocumentRooms`, run after the commit: the loaded rooms end unsaved. */
  endRooms: (documentIds: readonly DocumentId[]) => Promise<void>,
  documentIds: readonly DocumentId[],
): Promise<Released> {
  if (documentIds.length === 0) return { documentIds: [], storageUrls: [] };
  const tx = currentDrizzleDb(db);
  for (const id of [...new Set(documentIds)].sort()) await lockDocumentMutation(tx, id);
  const held = await tx
    .select({ id: documents.id, storageUrl: documents.storageUrl })
    .from(documents)
    .where(and(inArray(documents.id, [...documentIds]), isNull(documents.contentPurgedAt)));
  const list = held.map(({ id }) => id as DocumentId);
  if (list.length === 0) return { documentIds: [], storageUrls: [] };
  deferUntilDrizzleCommit(() => endRooms(list));
  // A fork's delete takes its room's snapshots (a trigger); the live room's go by key.
  await tx.delete(documentForks).where(inArray(documentForks.documentId, list));
  await tx
    .delete(documentSnapshots)
    .where(inArray(documentSnapshots.roomKey, list.map(liveRoomKey)));
  await tx.delete(documentBlockRooms).where(inArray(documentBlockRooms.documentId, list));
  await tx.delete(documentLinks).where(inArray(documentLinks.sourceDocumentId, list));
  // Observation frontiers have no document foreign key; their room key is the only ownership.
  await tx
    .delete(observationFrontiers)
    .where(inArray(observationFrontiers.roomKey, list.map(liveRoomKey)));
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
