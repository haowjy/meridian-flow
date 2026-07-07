/** Postgres transaction lock for live document mutation journal commits. */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { documentMutationLockKey } from "../domain/document-mutation-lock.js";

type DocumentMutationLockDb = Pick<Database, "execute">;

export async function lockDocumentMutation(
  db: DocumentMutationLockDb,
  documentIdOrBranchId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${documentMutationLockKey(documentIdOrBranchId)}, 0::bigint))`,
  );
}
