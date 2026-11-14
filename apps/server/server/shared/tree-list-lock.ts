/** The advisory lock that serializes a project's tree list: its admissions and its Works' lifecycle. */
import { sql } from "drizzle-orm";
import { lockDocumentMutation } from "./document-mutation-lock.js";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";

/**
 * Takes the keys of the project's list and its owner's account list, in list-id order, after
 * the Work rows and lifecycle locks the caller holds and before any document or namespace key
 * (the order in `collab/.context/CONTEXT.md`). A Work's close, archive, restore or delete takes
 * them so the open Works an admission reads, under the same key, are current; the Work's drafts
 * may sit in either list, and a command that names both takes them in this order too.
 */
export async function lockProjectTreeList(db: DrizzleDb, projectId: string): Promise<void> {
  const tx = currentDrizzleDb(db);
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT p.tree_list_id::text AS id FROM projects p WHERE p.id = ${projectId}::uuid
    UNION
    SELECT u.tree_list_id::text FROM projects p JOIN users u ON u.id = p.user_id
    WHERE p.id = ${projectId}::uuid
    ORDER BY id`);
  for (const row of rows) await lockDocumentMutation(tx, row.id);
}
