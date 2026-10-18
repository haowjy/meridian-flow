/** Postgres transaction lock serializing mutations of one live document or branch. */
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
}
