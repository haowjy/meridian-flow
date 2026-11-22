/** Postgres transaction lock serializing mutations of one live document or tree list. */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";

type DocumentMutationLockDb = Pick<Database, "execute">;

/** Shared key for serializing mutations against one live document. */
function documentMutationLockKey(documentId: string): string {
  return `document-mutation:${documentId}`;
}

export async function lockDocumentMutation(
  db: DocumentMutationLockDb,
  documentId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${documentMutationLockKey(documentId)}, 0::bigint))`,
  );
}
