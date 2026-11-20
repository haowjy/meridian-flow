/**
 * Postgres transaction lock serializing mutations of one live document or draft. A document
 * with a head also takes the head row, before the caller reads anything: typing holds only that
 * row (it allocates journal ids under it), so a command that read the journal before taking it
 * could miss a keystroke that commits below the command's own rows.
 */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";

type DocumentMutationLockDb = Pick<Database, "execute">;

/** Shared key for serializing mutations against one live document. */
function documentMutationLockKey(documentIdOrDraftId: string): string {
  return `document-mutation:${documentIdOrDraftId}`;
}

export async function lockDocumentMutation(
  db: DocumentMutationLockDb,
  documentIdOrDraftId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${documentMutationLockKey(documentIdOrDraftId)}, 0::bigint))`,
  );
  await db.execute(
    sql`SELECT 1 FROM document_yjs_heads WHERE document_id = ${documentIdOrDraftId}::uuid FOR UPDATE`,
  );
}
