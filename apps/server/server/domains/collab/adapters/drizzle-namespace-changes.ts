/** Drizzle store for the model's creates, moves and deletes of whole documents (`agent_namespace_changes`). */
import type { ModelResponseId } from "@meridian/contracts";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { agentEditMutations, agentNamespaceChanges, documents } from "@meridian/database/schema";
import { and, asc, desc, eq, inArray, isNotNull, max, or, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type {
  AgentNamespaceChangeStore,
  NamespaceChangeOwner,
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
    draftBranchId: row.draftBranchId,
    fromUri: row.fromUri,
    status: row.status,
    reversedAt: row.reversedAt,
  };
  if (row.kind !== "move") return { ...base, kind: row.kind };
  if (row.toUri === null) throw new Error(`Move ${row.id} has no destination`);
  return { ...base, kind: "move", toUri: row.toUri };
}

function owner(change: NamespaceChangeOwner) {
  return {
    documentId: change.documentId as DocumentId,
    threadId: change.threadId as ThreadId,
    turnId: change.turnId as TurnId | null,
    responseId: change.responseId as ModelResponseId | null,
    draftBranchId: change.draftBranchId,
  };
}

export function createDrizzleAgentNamespaceChanges(db: Database): AgentNamespaceChangeStore {
  return {
    async record(change) {
      const tx = currentDrizzleDb(db);
      const wId = await reserveWriteOrdinal(tx, change);
      const [row] = await tx
        .insert(agentNamespaceChanges)
        .values({
          ...owner(change),
          wId,
          kind: change.kind,
          fromUri: change.fromUri,
          toUri: change.kind === "move" ? change.toUri : null,
        })
        .returning();
      if (!row) throw new Error("Failed to record the namespace change");
      return toRecord(row);
    },

    async recordCreate(change) {
      const [row] = await currentDrizzleDb(db)
        .insert(agentNamespaceChanges)
        .values({ ...owner(change), wId: change.wId, kind: "create", fromUri: change.fromUri })
        .returning({ id: agentNamespaceChanges.id });
      if (!row) throw new Error("Failed to record the create");
      return row.id;
    },

    async discard(ids) {
      if (ids.length === 0) return;
      await currentDrizzleDb(db)
        .delete(agentNamespaceChanges)
        .where(inArray(agentNamespaceChanges.id, [...ids]));
    },

    async history(documentId, threadId) {
      const tx = currentDrizzleDb(db);
      const [rows, content] = await Promise.all([
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
      ]);
      return {
        namespace: rows.map(toRecord),
        content: content.map((handle) => ({
          wId: handle.wId,
          status: handle.status === "reversed" ? "reversed" : "active",
          reversedAt: handle.reversedAt,
        })),
      };
    },

    async forTurn(threadId, turnId, status) {
      const rows = await currentDrizzleDb(db)
        .select()
        .from(agentNamespaceChanges)
        .where(
          and(
            eq(agentNamespaceChanges.threadId, threadId as ThreadId),
            eq(agentNamespaceChanges.turnId, turnId as TurnId),
            eq(agentNamespaceChanges.status, status),
          ),
        )
        .orderBy(asc(agentNamespaceChanges.id));
      return rows.map(toRecord);
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
            or(
              and(
                eq(agentNamespaceChanges.kind, "delete"),
                eq(agentNamespaceChanges.status, "active"),
              ),
              and(
                eq(agentNamespaceChanges.kind, "create"),
                eq(agentNamespaceChanges.status, "reversed"),
              ),
            ),
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
  };
}
