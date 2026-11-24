import { sql } from "drizzle-orm";
import { lockDocumentMutation } from "./document-mutation-lock.js";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";

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
