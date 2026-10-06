/** Drizzle store for the model's moves and deletes of whole documents (`agent_namespace_changes`). */
import { writeHandle } from "@meridian/agent-edit/integration";
import type { ModelResponseId } from "@meridian/contracts";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { agentNamespaceChanges } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { AgentNamespaceChanges } from "../domain/ports/agent-namespace-changes.js";
import { reserveWriteOrdinal } from "./write-ordinals.js";

export function createDrizzleAgentNamespaceChanges(db: Database): AgentNamespaceChanges {
  return {
    record(change) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        const wId = await reserveWriteOrdinal(tx, change);
        const [row] = await tx
          .insert(agentNamespaceChanges)
          .values({
            wId,
            documentId: change.documentId as DocumentId,
            threadId: change.threadId as ThreadId,
            turnId: change.turnId as TurnId | null,
            responseId: change.responseId as ModelResponseId | null,
            kind: change.kind,
            fromUri: change.fromUri,
            toUri: change.kind === "move" ? change.toUri : null,
          })
          .returning({ id: agentNamespaceChanges.id });
        if (!row) throw new Error("Failed to record the namespace change");
        return { id: row.id, handle: writeHandle(wId) };
      });
    },
    async discard(id) {
      await currentDrizzleDb(db)
        .delete(agentNamespaceChanges)
        .where(eq(agentNamespaceChanges.id, id));
    },
  };
}
