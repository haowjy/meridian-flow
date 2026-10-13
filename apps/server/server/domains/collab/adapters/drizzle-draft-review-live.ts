/** Live authority revision shared by review capture and the durable action fence. */
import type { DocumentId } from "@meridian/contracts/runtime";
import { documentYjsHeads } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";

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
