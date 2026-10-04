/** Postgres transaction lock serializing mutations of one live document or branch. */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";

type DocumentMutationLockDb = Pick<Database, "execute">;

/** Shared key for serializing mutations against one live document. */
export function documentMutationLockKey(documentIdOrBranchId: string): string {
  return `document-mutation:${documentIdOrBranchId}`;
}

export async function lockDocumentMutation(
  db: DocumentMutationLockDb,
  documentIdOrBranchId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${documentMutationLockKey(documentIdOrBranchId)}, 0::bigint))`,
  );
}
