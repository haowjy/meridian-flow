/**
 * The model's edit handles (`e<N>`), one counter per document (or tree node) and chat, shared by
 * its text writes and tree changes so Undo, Redo and `revert` order both by it.
 */
import type { WriteOrdinals } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { agentEditWidCounters } from "@meridian/database/schema";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

export function createDrizzleWriteOrdinals(db: Database): WriteOrdinals {
  return {
    async reserveWriteOrdinal(documentId, threadId) {
      const [counter] = await currentDrizzleDb(db)
        .insert(agentEditWidCounters)
        .values({
          documentId: documentId as DocumentId,
          threadId: threadId as ThreadId,
          nextWid: 1,
        })
        .onConflictDoUpdate({
          target: [agentEditWidCounters.documentId, agentEditWidCounters.threadId],
          set: { nextWid: sql`${agentEditWidCounters.nextWid} + 1` },
        })
        .returning({ wId: agentEditWidCounters.nextWid });
      if (!counter) throw new Error("Failed to allocate agent edit w-id");
      return counter.wId;
    },
  };
}
