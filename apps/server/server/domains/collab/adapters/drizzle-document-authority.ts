/** Allocates ordered journal admissions inside one durable document authority generation. */

import type { DocumentAuthorityId, DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documentYjsHeads } from "@meridian/database";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { eq, sql } from "drizzle-orm";

type AuthorityDb = Pick<Database, "insert" | "update" | "select">;

export type DocumentAuthorityGeneration = {
  authorityId: DocumentAuthorityId;
  generation: bigint;
};

export async function allocateDocumentAdmission(
  db: AuthorityDb,
  documentId: string,
): Promise<DocumentAuthorityGeneration & { admissionSequence: bigint }> {
  await ensureDocumentAuthority(db, documentId);
  const [row] = await db
    .update(documentYjsHeads)
    .set({
      nextAdmissionSequence: sql`${documentYjsHeads.nextAdmissionSequence} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(documentYjsHeads.documentId, documentId as DocumentId))
    .returning({
      authorityId: documentYjsHeads.authorityId,
      generation: documentYjsHeads.authorityGeneration,
      nextAdmissionSequence: documentYjsHeads.nextAdmissionSequence,
    });
  if (!row) throw new Error("Failed to allocate document authority admission");
  return {
    authorityId: row.authorityId,
    generation: row.generation,
    admissionSequence: row.nextAdmissionSequence - 1n,
  };
}

export async function readDocumentAuthority(
  db: AuthorityDb,
  documentId: string,
): Promise<DocumentAuthorityGeneration> {
  await ensureDocumentAuthority(db, documentId);
  const [row] = await db
    .select({
      authorityId: documentYjsHeads.authorityId,
      generation: documentYjsHeads.authorityGeneration,
    })
    .from(documentYjsHeads)
    .where(eq(documentYjsHeads.documentId, documentId as DocumentId))
    .limit(1);
  if (!row) throw new Error("Failed to read document authority");
  return row;
}

async function ensureDocumentAuthority(db: AuthorityDb, documentId: string): Promise<void> {
  await db
    .insert(documentYjsHeads)
    .values({ documentId: documentId as DocumentId, schemaVersion: COLLAB_SCHEMA_VERSION })
    .onConflictDoNothing({ target: documentYjsHeads.documentId });
}
