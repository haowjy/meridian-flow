/** Drizzle adapter for persisted collab draft review state. */

import { randomUUID } from "node:crypto";
import { DRAFT_ACCEPT_TURN_TEXT, draftAcceptTurnRequestParams } from "@meridian/contracts/drafts";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  agentEditSyncState,
  agentEditWidCounters,
  documents,
  documentYjsDrafts,
  documentYjsDraftUpdates,
  documentYjsHeads,
  documentYjsReversals,
  documentYjsUpdates,
  threads,
  turnBlocks,
  turns,
} from "@meridian/database";
import { and, asc, desc, eq, isNull, max, or, sql } from "drizzle-orm";
import type {
  AcceptedDraftAppend,
  ActiveDraft,
  Draft,
  DraftAcceptJournal,
  DraftStore,
  DraftUpdate,
} from "../domain/drafts.js";
import { ActiveDraftConflictError, createDraftId } from "../domain/drafts.js";
import { LIVE_SCOPE, scopedWhere } from "./drizzle-agent-edit-scope.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

const ACTIVE_DRAFT_UNIQUE_CONSTRAINT = "document_yjs_drafts_active_document_thread";

// Drizzle's transaction subtype is structurally compatible with the table methods we use.
type DraftDb = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

export function createDrizzleDraftStore(
  db: DraftDb,
  options: { latestLiveUpdateSeq?: (documentId: DocumentId) => Promise<number> } = {},
): DraftStore {
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

    async listActiveDrafts(input) {
      const rows = await db
        .select({ draft: documentYjsDrafts, documentName: documents.name })
        .from(documentYjsDrafts)
        .leftJoin(documents, eq(documents.id, documentYjsDrafts.documentId))
        .where(
          and(
            eq(documentYjsDrafts.threadId, input.threadId),
            eq(documentYjsDrafts.status, "active"),
          ),
        )
        .orderBy(desc(documentYjsDrafts.updatedAt), asc(documentYjsDrafts.id));
      return rows.map((row) => mapActiveDraft(row.draft, row.documentName));
    },

    async getAppliedDraft(draftId) {
      const [row] = await db
        .select()
        .from(documentYjsDrafts)
        .where(and(eq(documentYjsDrafts.id, draftId), eq(documentYjsDrafts.status, "applied")))
        .limit(1);
      return row ? mapDraft(row) : null;
    },

    async createActiveDraft(input) {
      try {
        const baseLiveUpdateSeq =
          input.baseLiveUpdateSeq ??
          (await latestLiveUpdateSeq(db, options.latestLiveUpdateSeq, input.documentId));
        const [row] = await db
          .insert(documentYjsDrafts)
          .values({
            id: createDraftId(),
            documentId: input.documentId,
            threadId: input.threadId,
            status: "active",
            baseLiveUpdateSeq,
            lastActorTurnId: input.lastActorTurnId ?? null,
          })
          .returning();
        if (!row) throw new Error("Failed to create draft");
        return mapDraft(row);
      } catch (cause) {
        if (isUniqueViolation(cause, ACTIVE_DRAFT_UNIQUE_CONSTRAINT)) {
          throw new ActiveDraftConflictError(input);
        }
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
        const updated = await (tx as DraftDb)
          .update(documentYjsDrafts)
          .set({
            ...(input.actorTurnId ? { lastActorTurnId: input.actorTurnId } : {}),
            updatedAt: sql`now()`,
          })
          .where(
            and(eq(documentYjsDrafts.id, input.draftId), eq(documentYjsDrafts.status, "active")),
          )
          .returning({ id: documentYjsDrafts.id });
        if (updated.length === 0) throw new Error(`Draft is closed: ${input.draftId}`);
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

    async claimForAccept(input) {
      const [row] = await db
        .update(documentYjsDrafts)
        .set({
          status: "accepting",
          claimedAt: sql`now()`,
          claimToken: randomUUID(),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(documentYjsDrafts.id, input.draftId),
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.threadId, input.threadId),
            or(
              and(
                eq(documentYjsDrafts.status, "active"),
                or(
                  isNull(documentYjsDrafts.claimedAt),
                  sql`${documentYjsDrafts.claimedAt} < now() - interval '10 minutes'`,
                ),
              ),
              and(
                eq(documentYjsDrafts.status, "accepting"),
                sql`${documentYjsDrafts.claimedAt} < now() - interval '10 minutes'`,
              ),
            ),
          ),
        )
        .returning();
      return row ? mapDraft(row) : null;
    },

    async getAcceptingDraft(input) {
      const [row] = await db
        .select()
        .from(documentYjsDrafts)
        .where(
          and(
            eq(documentYjsDrafts.id, input.draftId),
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.threadId, input.threadId),
            eq(documentYjsDrafts.status, "accepting"),
          ),
        )
        .limit(1);
      return row ? mapDraft(row) : null;
    },

    async discardActive(input) {
      const [row] = await db
        .update(documentYjsDrafts)
        .set({
          status: "discarded",
          discardedAt: sql`now()`,
          claimedAt: null,
          claimToken: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(documentYjsDrafts.id, input.draftId),
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.threadId, input.threadId),
            eq(documentYjsDrafts.status, "active"),
            or(
              isNull(documentYjsDrafts.claimedAt),
              sql`${documentYjsDrafts.claimedAt} < now() - interval '10 minutes'`,
            ),
          ),
        )
        .returning();
      return row ? mapDraft(row) : null;
    },

    async markApplied(draftId, input) {
      const row = await db
        .update(documentYjsDrafts)
        .set({
          status: "applied",
          appliedAt: sql`now()`,
          appliedByUserId: input.appliedByUserId,
          appliedUpdateSeq: input.appliedUpdateSeq,
          claimedAt: null,
          claimToken: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(documentYjsDrafts.id, draftId),
            eq(documentYjsDrafts.status, "accepting"),
            eq(documentYjsDrafts.claimToken, input.claimToken),
          ),
        )
        .returning({ id: documentYjsDrafts.id });
      return row.length > 0;
    },

    async markDiscarded(draftId, input) {
      const row = await db
        .update(documentYjsDrafts)
        .set({
          status: "discarded",
          discardedAt: sql`now()`,
          claimedAt: null,
          claimToken: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(documentYjsDrafts.id, draftId),
            or(eq(documentYjsDrafts.status, "active"), eq(documentYjsDrafts.status, "accepting")),
            eq(documentYjsDrafts.claimToken, input.claimToken),
          ),
        )
        .returning({ id: documentYjsDrafts.id });
      return row.length > 0;
    },

    async deleteDraftState(input) {
      const scopedInput = { ...input, scopeId: input.draftId };
      await db.transaction(async (tx) => {
        const txDb = tx as DraftDb;
        await txDb.delete(agentEditSyncState).where(scopedWhere(agentEditSyncState, scopedInput));
        await txDb
          .delete(documentYjsReversals)
          .where(scopedWhere(documentYjsReversals, scopedInput));
        await txDb.delete(agentEditMutations).where(scopedWhere(agentEditMutations, scopedInput));
        await txDb
          .delete(agentEditWidCounters)
          .where(scopedWhere(agentEditWidCounters, scopedInput));
      });
    },
  };
}

export function createDrizzleDraftAcceptJournal(db: DraftDb): DraftAcceptJournal {
  return {
    findAcceptedDraftAppend: (input) => findAcceptedDraftAppend(db, input),
    async appendAcceptedDraft(input) {
      return db.transaction(async (tx) => {
        const txDb = tx as DraftDb;
        await insertDraftAcceptTurn(txDb, input);
        const existing = await findAcceptedDraftAppend(txDb, input);
        if (existing) return existing;

        const txJournal = createDrizzleJournal(tx as Parameters<typeof createDrizzleJournal>[0]);
        const [result] = await txJournal.appendBatch([
          {
            docId: input.documentId,
            update: input.update,
            meta: { origin: "system", actorTurnId: input.actorTurnId, seq: 0 },
            mutation: {
              threadId: input.threadId,
              turnId: input.acceptTurnId,
              writeId: input.writeId,
            },
          },
        ]);
        if (!result) throw new Error(`Failed to append accepted draft ${input.draftId}`);
        return { appliedUpdateSeq: result.seq, acceptTurnId: input.acceptTurnId };
      });
    },
  };
}

async function findAcceptedDraftAppend(
  db: Pick<Database, "select">,
  input: { documentId: DocumentId; threadId: ThreadId; writeId: string },
): Promise<AcceptedDraftAppend | null> {
  const [row] = await db
    .select({ createdSeq: agentEditMutations.createdSeq, turnId: agentEditMutations.turnId })
    .from(agentEditMutations)
    .where(
      scopedWhere(
        agentEditMutations,
        { documentId: input.documentId, threadId: input.threadId, scopeId: LIVE_SCOPE },
        eq(agentEditMutations.writeId, input.writeId),
      ),
    )
    .limit(1);
  return row ? { appliedUpdateSeq: Number(row.createdSeq), acceptTurnId: row.turnId } : null;
}

async function insertDraftAcceptTurn(
  db: DraftDb,
  input: Parameters<DraftAcceptJournal["appendAcceptedDraft"]>[0],
): Promise<void> {
  const now = new Date();
  const [thread] = await db
    .select({ activeLeafTurnId: threads.activeLeafTurnId })
    .from(threads)
    .where(eq(threads.id, input.threadId))
    .limit(1);
  const parentTurnId = thread?.activeLeafTurnId ?? input.actorTurnId;

  await db
    .insert(turns)
    .values({
      id: input.acceptTurnId,
      threadId: input.threadId,
      parentTurnId,
      role: "user",
      status: "complete",
      finishReason: "end_turn",
      requestParams: draftAcceptTurnRequestParams({
        draftId: input.draftId,
        documentId: input.documentId,
      }),
      completedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing({ target: turns.id });

  await db
    .insert(turnBlocks)
    .values({
      id: input.acceptBlockId,
      turnId: input.acceptTurnId,
      blockType: "text",
      status: "complete",
      sequence: 0,
      modelText: DRAFT_ACCEPT_TURN_TEXT,
      content: DRAFT_ACCEPT_TURN_TEXT,
      compact: "",
    })
    .onConflictDoNothing({ target: turnBlocks.id });

  await db
    .update(threads)
    .set({ activeLeafTurnId: input.acceptTurnId, updatedAt: now })
    .where(eq(threads.id, input.threadId));
}

function mapDraft(row: typeof documentYjsDrafts.$inferSelect): Draft {
  return {
    id: row.id,
    documentId: row.documentId as DocumentId,
    threadId: row.threadId as ThreadId,
    status: row.status,
    baseLiveUpdateSeq: Number(row.baseLiveUpdateSeq),
    lastActorTurnId: (row.lastActorTurnId as TurnId | null) ?? null,
    appliedAt: row.appliedAt,
    appliedByUserId: (row.appliedByUserId as UserId | null) ?? null,
    appliedUpdateSeq: row.appliedUpdateSeq === null ? null : Number(row.appliedUpdateSeq),
    discardedAt: row.discardedAt,
    claimedAt: row.claimedAt,
    claimToken: row.claimToken,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function latestLiveUpdateSeq(
  db: DraftDb,
  override: ((documentId: DocumentId) => Promise<number>) | undefined,
  documentId: DocumentId,
): Promise<number> {
  if (override) return override(documentId);
  const [row] = await db
    .select({ latestSeq: documentYjsHeads.latestUpdateSeq })
    .from(documentYjsHeads)
    .where(eq(documentYjsHeads.documentId, documentId))
    .limit(1);
  if (row?.latestSeq !== null && row?.latestSeq !== undefined) return Number(row.latestSeq);
  const [updateRow] = await db
    .select({ latestSeq: max(documentYjsUpdates.id) })
    .from(documentYjsUpdates)
    .where(eq(documentYjsUpdates.documentId, documentId));
  return updateRow?.latestSeq === null || updateRow?.latestSeq === undefined
    ? 0
    : Number(updateRow.latestSeq);
}

function mapActiveDraft(
  row: typeof documentYjsDrafts.$inferSelect,
  documentName: string | null,
): ActiveDraft {
  return { ...mapDraft(row), status: "active", documentName };
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

function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  for (const cause of errorCauseChain(error)) {
    if (!isErrorRecord(cause) || cause.code !== "23505") continue;
    if (!constraintName || cause.constraint_name === constraintName) return true;
  }
  return false;
}

function* errorCauseChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = isErrorRecord(current) ? current.cause : undefined;
  }
}

function isErrorRecord(error: unknown): error is Record<string, unknown> {
  return typeof error === "object" && error !== null;
}
