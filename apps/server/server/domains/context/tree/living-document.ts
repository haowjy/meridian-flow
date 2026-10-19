/**
 * The living-document requirement: a document row exists and carries no tombstone. Every
 * write that may create or change a document's Yjs state proves it under the document's
 * mutation lock, which a removal also takes, so a removal that won the lock is seen here.
 */
import { DocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database/schema";
import { type AnyColumn, eq, type SQL, sql } from "drizzle-orm";
import { readRemovalRecords } from "./removal.js";

type LivingDocumentDb = Pick<Database, "select">;

/**
 * The requirement as a predicate on a document-id expression, for a statement that already
 * runs (an admission's head update), so the admitted path pays no extra query.
 */
export function livingDocumentSql(documentId: SQL | AnyColumn): SQL {
  return sql`exists (select 1 from documents d where d.id = ${documentId} and d.deleted_at is null)`;
}

/** Why the document is not living: not found with its removal record, or no row at all. */
export async function livingDocumentRefusal(
  db: LivingDocumentDb,
  documentId: DocumentId,
): Promise<DocumentNotFoundError | null> {
  const [row] = await db
    .select({ deletedAt: documents.deletedAt })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!row) return new DocumentNotFoundError(documentId, `Document ${documentId} does not exist`);
  if (row.deletedAt === null) return null;
  const removal = (await readRemovalRecords(db, [documentId])).get(documentId);
  // No record means a Restore committed between the two reads: the document lives again.
  return removal
    ? new DocumentNotFoundError(documentId, `Document ${documentId} was ${removal.reason}`, {
        removal,
      })
    : null;
}

/** Called under the document's mutation lock; throws the refusal when it is not living. */
export async function requireLivingDocument(
  db: LivingDocumentDb,
  documentId: DocumentId,
): Promise<void> {
  const refusal = await livingDocumentRefusal(db, documentId);
  if (refusal) throw refusal;
}
