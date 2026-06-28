/** Drizzle adapter for persisted collab draft review state. */

import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  agentEditSyncState,
  agentEditWidCounters,
  documentYjsDrafts,
  documentYjsDraftUpdates,
  documentYjsReversals,
} from "@meridian/database";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Draft, DraftAcceptJournal, DraftStore, DraftUpdate } from "../domain/drafts.js";
import { ActiveDraftConflictError, createDraftId } from "../domain/drafts.js";
import { LIVE_SCOPE, scopedWhere } from "./drizzle-agent-edit-scope.js";

// Drizzle's transaction subtype is structurally compatible with the table methods we use.
type DraftDb = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

export function createDrizzleDraftStore(db: DraftDb): DraftStore {
  return {
    async getDraft(draftId) {
      const [row] = await db
        .select()
        .from(documentYjsDrafts)
        .where(eq(documentYjsDrafts.id, draftId))
        .limit(1);
      return row ? mapDraft(row) : null;
    },

    async getActiveDraft(input) {
      const [row] = await db
        .select()
        .from(documentYjsDrafts)
        .where(
          and(
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.threadId, input.threadId),
            eq(documentYjsDrafts.status, "active"),
          ),
        )
        .limit(1);
      return row ? mapDraft(row) : null;
    },

    async getLastAppliedDraft(input) {
      const [row] = await db
        .select()
        .from(documentYjsDrafts)
        .where(
          and(
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.threadId, input.threadId),
            eq(documentYjsDrafts.status, "applied"),
          ),
        )
        .orderBy(desc(documentYjsDrafts.appliedAt), desc(documentYjsDrafts.updatedAt))
        .limit(1);
      return row ? mapDraft(row) : null;
    },

    async createActiveDraft(input) {
      try {
        const [row] = await db
          .insert(documentYjsDrafts)
          .values({
            id: createDraftId(),
            documentId: input.documentId,
            threadId: input.threadId,
            status: "active",
            lastActorTurnId: input.lastActorTurnId ?? null,
          })
          .returning();
        if (!row) throw new Error("Failed to create draft");
        return mapDraft(row);
      } catch (cause) {
        if (isUniqueConstraintViolation(cause)) throw new ActiveDraftConflictError(input);
        throw cause;
      }
    },

    async appendUpdate(input) {
      await db.transaction(async (tx) => {
        await (tx as DraftDb).insert(documentYjsDraftUpdates).values({
          draftId: input.draftId,
          updateData: Buffer.from(input.updateData),
          actorTurnId: input.actorTurnId ?? null,
        });
        await (tx as DraftDb)
          .update(documentYjsDrafts)
          .set({
            ...(input.actorTurnId ? { lastActorTurnId: input.actorTurnId } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(documentYjsDrafts.id, input.draftId));
      });
    },

    async listUpdates(draftId) {
      const rows = await db
        .select()
        .from(documentYjsDraftUpdates)
        .where(eq(documentYjsDraftUpdates.draftId, draftId))
        .orderBy(asc(documentYjsDraftUpdates.id));
      return rows.map(mapDraftUpdate);
    },

    async claimActive(input) {
      const [row] = await db
        .update(documentYjsDrafts)
        .set({ updatedAt: sql`now()` })
        .where(
          and(
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.threadId, input.threadId),
            eq(documentYjsDrafts.status, "active"),
          ),
        )
        .returning();
      return row ? mapDraft(row) : null;
    },

    async markApplied(draftId, input) {
      await db
        .update(documentYjsDrafts)
        .set({
          status: "applied",
          appliedAt: sql`now()`,
          appliedByUserId: input.appliedByUserId,
          appliedUpdateSeq: input.appliedUpdateSeq,
          updatedAt: sql`now()`,
        })
        .where(eq(documentYjsDrafts.id, draftId));
    },

    async markDiscarded(draftId) {
      await db
        .update(documentYjsDrafts)
        .set({ status: "discarded", discardedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(documentYjsDrafts.id, draftId));
    },

    async deleteScopedState(input) {
      await db.transaction(async (tx) => {
        const txDb = tx as DraftDb;
        await txDb.delete(agentEditSyncState).where(scopedWhere(agentEditSyncState, input));
        await txDb.delete(documentYjsReversals).where(scopedWhere(documentYjsReversals, input));
        await txDb.delete(agentEditMutations).where(scopedWhere(agentEditMutations, input));
        await txDb.delete(agentEditWidCounters).where(scopedWhere(agentEditWidCounters, input));
      });
    },
  };
}

export function createDrizzleDraftAcceptJournal(
  db: Pick<Database, "select">,
  journal: Pick<DraftAcceptJournal, "appendBatch">,
): DraftAcceptJournal {
  return {
    appendBatch: journal.appendBatch.bind(journal),
    async findUpdateSeqByWriteId(input) {
      const [row] = await db
        .select({ createdSeq: agentEditMutations.createdSeq })
        .from(agentEditMutations)
        .where(
          scopedWhere(
            agentEditMutations,
            { documentId: input.documentId, threadId: input.threadId, scopeId: LIVE_SCOPE },
            eq(agentEditMutations.writeId, input.writeId),
          ),
        )
        .limit(1);
      return row ? Number(row.createdSeq) : null;
    },
  };
}

function mapDraft(row: typeof documentYjsDrafts.$inferSelect): Draft {
  return {
    id: row.id,
    documentId: row.documentId as DocumentId,
    threadId: row.threadId as ThreadId,
    status: row.status,
    lastActorTurnId: (row.lastActorTurnId as TurnId | null) ?? null,
    appliedAt: row.appliedAt,
    appliedByUserId: (row.appliedByUserId as UserId | null) ?? null,
    appliedUpdateSeq: row.appliedUpdateSeq === null ? null : Number(row.appliedUpdateSeq),
    discardedAt: row.discardedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapDraftUpdate(row: typeof documentYjsDraftUpdates.$inferSelect): DraftUpdate {
  return {
    id: row.id,
    draftId: row.draftId,
    updateData: new Uint8Array(row.updateData),
    actorTurnId: (row.actorTurnId as TurnId | null) ?? null,
    createdAt: row.createdAt,
  };
}

function isUniqueConstraintViolation(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}
