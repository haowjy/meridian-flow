/** The advisory lock that serializes a project's tree list: its admissions and its Works' lifecycle. */
import { sql } from "drizzle-orm";
import { lockDocumentMutation } from "./document-mutation-lock.js";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";

/**
 * Takes the list's key for the project, after the Work rows and lifecycle locks the caller holds
 * and before any document or namespace key (the order in `collab/.context/CONTEXT.md`). A Work's
 * close, archive, restore or delete takes it so the open Works an admission reads, under the same
 * key, are current.
 */
export async function lockProjectTreeList(db: DrizzleDb, projectId: string): Promise<void> {
  const tx = currentDrizzleDb(db);
  const [row] = await tx.execute<{ id: string }>(
    sql`SELECT tree_list_id::text AS id FROM projects WHERE id = ${projectId}::uuid`,
  );
  if (row) await lockDocumentMutation(tx, row.id);
}
