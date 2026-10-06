/** Drizzle store for the model's moves and deletes of whole documents (`agent_namespace_changes`). */
import { writeHandle } from "@meridian/agent-edit/integration";
import type { ModelResponseId } from "@meridian/contracts";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { agentEditMutations, agentNamespaceChanges, documents } from "@meridian/database/schema";
import { and, asc, desc, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type {
  AgentNamespaceChanges,
  NamespaceChangeRecord,
} from "../domain/ports/agent-namespace-changes.js";
import { reserveWriteOrdinal } from "./write-ordinals.js";

type Row = typeof agentNamespaceChanges.$inferSelect;

function toRecord(row: Row): NamespaceChangeRecord {
  const base = {
    id: row.id,
    documentId: row.documentId,
    wId: row.wId,
    turnId: row.turnId,
    fromUri: row.fromUri,
    status: row.status,
    reversedAt: row.reversedAt,
  };
  if (row.kind === "move" && row.toUri !== null) return { ...base, kind: "move", toUri: row.toUri };
  if (row.kind === "delete") return { ...base, kind: "delete" };
  throw new Error(`Namespace change ${row.id} is not a handle (${row.kind})`);
}

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

    async history(documentId, threadId) {
      const tx = currentDrizzleDb(db);
      const [rows, content, [document]] = await Promise.all([
        tx
          .select()
          .from(agentNamespaceChanges)
          .where(
            and(
              eq(agentNamespaceChanges.documentId, documentId as DocumentId),
              eq(agentNamespaceChanges.threadId, threadId as ThreadId),
            ),
          )
          .orderBy(asc(agentNamespaceChanges.wId)),
        // One handle can span rows; they share a status.
        tx
          .select({
            wId: agentEditMutations.wId,
            status: max(agentEditMutations.status),
            reversedAt: max(agentEditMutations.reversedAt),
          })
          .from(agentEditMutations)
          .where(
            and(
              eq(agentEditMutations.documentId, documentId as DocumentId),
              eq(agentEditMutations.threadId, threadId as ThreadId),
            ),
          )
          .groupBy(agentEditMutations.wId)
          .orderBy(asc(agentEditMutations.wId)),
        tx
          .select({
            deleted: sql<boolean>`${documents.deletedAt} IS NOT NULL`,
            copied: sql<boolean>`(${documents.metadata} -> 'copiedFrom') IS NOT NULL`,
          })
          .from(documents)
          .where(eq(documents.id, documentId as DocumentId)),
      ]);
      const discard = rows.find((row) => row.kind === "discard" && row.status === "active");
      return {
        namespace: rows.filter((row) => row.kind !== "discard").map(toRecord),
        content: content.map((handle) => ({
          wId: handle.wId,
          status: handle.status === "reversed" ? "reversed" : "active",
          reversedAt: handle.reversedAt,
        })),
        discardedCopy: discard
          ? {
              id: discard.id,
              documentId: discard.documentId,
              wId: discard.wId,
              fromUri: discard.fromUri,
            }
          : null,
        deleted: document?.deleted ?? true,
        copied: document?.copied ?? false,
      };
    },

    async findDeletedAt(threadId, uri) {
      const [row] = await currentDrizzleDb(db)
        .select({
          documentId: agentNamespaceChanges.documentId,
          fromUri: agentNamespaceChanges.fromUri,
        })
        .from(agentNamespaceChanges)
        .innerJoin(documents, eq(documents.id, agentNamespaceChanges.documentId))
        .where(
          and(
            eq(agentNamespaceChanges.threadId, threadId as ThreadId),
            eq(agentNamespaceChanges.fromUri, uri),
            eq(agentNamespaceChanges.status, "active"),
            inArray(agentNamespaceChanges.kind, ["delete", "discard"]),
            isNotNull(documents.deletedAt),
          ),
        )
        .orderBy(desc(agentNamespaceChanges.id))
        .limit(1);
      return row ?? null;
    },

    async findTurnDelete(threadId, turnId, documentId) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(agentNamespaceChanges)
        .where(
          and(
            eq(agentNamespaceChanges.threadId, threadId as ThreadId),
            eq(agentNamespaceChanges.turnId, turnId as TurnId),
            eq(agentNamespaceChanges.documentId, documentId as DocumentId),
            eq(agentNamespaceChanges.kind, "delete"),
            eq(agentNamespaceChanges.status, "active"),
          ),
        )
        .orderBy(desc(agentNamespaceChanges.id))
        .limit(1);
      return row ? toRecord(row) : null;
    },

    async transition(id, from) {
      const reversing = from === "active";
      const claimed = await currentDrizzleDb(db)
        .update(agentNamespaceChanges)
        .set({
          status: reversing ? "reversed" : "active",
          reversedAt: reversing ? sql`now()` : null,
        })
        .where(and(eq(agentNamespaceChanges.id, id), eq(agentNamespaceChanges.status, from)))
        .returning({ id: agentNamespaceChanges.id });
      return claimed.length > 0;
    },

    async recordDiscardedCopy(input) {
      await currentDrizzleDb(db)
        .insert(agentNamespaceChanges)
        .values({
          wId: input.wId,
          documentId: input.documentId as DocumentId,
          threadId: input.threadId as ThreadId,
          kind: "discard",
          fromUri: input.fromUri,
        });
    },

    async forgetDiscardedCopy(id) {
      await currentDrizzleDb(db)
        .delete(agentNamespaceChanges)
        .where(and(eq(agentNamespaceChanges.id, id), eq(agentNamespaceChanges.kind, "discard")));
    },
  };
}
