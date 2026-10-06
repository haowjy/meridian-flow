/**
 * Write handles (`w3`): one counter per document and thread, shared by the
 * model's content writes (`agent_edit_mutations`) and its moves and deletes
 * (`agent_namespace_changes`), so one document's handles form one sequence.
 */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { agentEditWidCounters } from "@meridian/database/schema";
import { sql } from "drizzle-orm";

export async function reserveWriteOrdinal(
  db: Pick<Database, "insert">,
  input: { documentId: string; threadId: string },
): Promise<number> {
  const [counter] = await db
    .insert(agentEditWidCounters)
    .values({
      documentId: input.documentId as DocumentId,
      threadId: input.threadId as ThreadId,
      nextWid: 1,
    })
    .onConflictDoUpdate({
      target: [agentEditWidCounters.documentId, agentEditWidCounters.threadId],
      set: { nextWid: sql`${agentEditWidCounters.nextWid} + 1` },
    })
    .returning({ wId: agentEditWidCounters.nextWid });
  if (!counter) throw new Error("Failed to allocate agent edit w-id");
  return counter.wId;
}
