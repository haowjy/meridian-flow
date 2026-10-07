/** Captures draft comparison bytes and live authority identity at one durable cut. */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentYjsHeads } from "@meridian/database/schema";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";

export async function readLiveReviewRevision(db: DrizzleDb, documentId: string): Promise<string> {
  const [head] = await db
    .select({
      authorityId: documentYjsHeads.authorityId,
      generation: documentYjsHeads.authorityGeneration,
      nextAdmissionSequence: documentYjsHeads.nextAdmissionSequence,
    })
    .from(documentYjsHeads)
    .where(eq(documentYjsHeads.documentId, documentId as DocumentId));
  return head
    ? `${head.authorityId}:${head.generation}:${head.nextAdmissionSequence}`
    : "uninitialized";
}

export function createDrizzleDraftReviewLive(db: Database, journal: UpdateJournal) {
  return (documentId: string): Promise<{ state: Uint8Array; revision: string }> =>
    runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db);
      await lockDocumentMutation(tx, documentId);
      const revision = await readLiveReviewRevision(tx, documentId);
      const snapshot = await journal.read(documentId);
      const doc = createCollabYDoc({ gc: false });
      try {
        if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
        for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
        return { state: Y.encodeStateAsUpdate(doc), revision };
      } finally {
        doc.destroy();
      }
    });
}
