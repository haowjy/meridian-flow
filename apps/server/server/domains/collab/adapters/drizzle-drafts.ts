/** Drizzle adapter for persisted collab draft review state. */

import { randomUUID } from "node:crypto";
import {
  draftAcceptTurnRequestParams,
  draftRejectTurnRequestParams,
  formatDraftAcceptTurnText,
  formatDraftRejectTurnText,
} from "@meridian/contracts/drafts";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
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
  folders,
  threads,
  threadWorks,
  turnBlocks,
  turns,
} from "@meridian/database";
import { and, asc, desc, eq, inArray, isNull, max, or, sql } from "drizzle-orm";
import type {
  AcceptedDraftAppend,
  ActiveDraft,
  AppliedDraft,
  Draft,
  DraftAcceptJournal,
  DraftStore,
  DraftUpdate,
  ReviewableDraft,
} from "../domain/drafts.js";
import { ActiveDraftConflictError, createDraftId } from "../domain/drafts.js";
import { LIVE_SCOPE } from "./drizzle-agent-edit-scope.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

const ACTIVE_DRAFT_UNIQUE_CONSTRAINT = "document_yjs_drafts_active_document_work";

// Drizzle's transaction subtype is structurally compatible with the table methods we use.
type DraftDb = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

export function createDrizzleDraftStore(
  db: DraftDb,
  options: { latestLiveUpdateSeq?: (documentId: DocumentId) => Promise<number> } = {},
): DraftStore {
  return {
    resolveWorkId: (threadId) => resolvePrimaryWorkId(db, threadId),

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
            eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, input.threadId)),
            eq(documentYjsDrafts.status, "active"),
          ),
        )
        .limit(1);
      return row ? mapDraft(row) : null;
    },

    async getActiveDraftByWork(input) {
      const [row] = await db
        .select()
        .from(documentYjsDrafts)
        .where(
          and(
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.workId, input.workId),
            eq(documentYjsDrafts.status, "active"),
          ),
        )
        .limit(1);
      return row ? mapDraft(row) : null;
    },

    async resolveDraftThreadId(draftId) {
      const [row] = await db
        .select({ threadId: turns.threadId })
        .from(documentYjsDrafts)
        .innerJoin(turns, eq(turns.id, documentYjsDrafts.lastActorTurnId))
        .where(eq(documentYjsDrafts.id, draftId))
        .limit(1);
      return (row?.threadId as ThreadId | undefined) ?? null;
    },

    async draftTurnContext(draftId) {
      const [row] = await db
        .select({
          documentName: documents.name,
          minWid: sql<number | null>`min(${agentEditMutations.wId})`,
          maxWid: sql<number | null>`max(${agentEditMutations.wId})`,
        })
        .from(documentYjsDrafts)
        .leftJoin(documents, eq(documents.id, documentYjsDrafts.documentId))
        .leftJoin(
          agentEditMutations,
          and(
            eq(agentEditMutations.documentId, documentYjsDrafts.documentId),
            eq(agentEditMutations.scopeId, documentYjsDrafts.id),
          ),
        )
        .where(eq(documentYjsDrafts.id, draftId))
        .groupBy(documentYjsDrafts.id, documents.name);
      if (!row) return null;
      return {
        documentName: row.documentName,
        wIdRange:
          row.minWid !== null && row.maxWid !== null ? { min: row.minWid, max: row.maxWid } : null,
      };
    },

    async listActiveDrafts(input) {
      const rows = await db
        .select({
          draft: documentYjsDrafts,
          documentName: documents.name,
          extension: documents.extension,
          folderId: documents.folderId,
        })
        .from(documentYjsDrafts)
        .leftJoin(documents, eq(documents.id, documentYjsDrafts.documentId))
        .where(
          and(
            eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, input.threadId)),
            eq(documentYjsDrafts.status, "active"),
          ),
        )
        .orderBy(desc(documentYjsDrafts.updatedAt), asc(documentYjsDrafts.id));
      return Promise.all(
        rows.map(async (row) =>
          mapActiveDraft(row.draft, row.documentName, await documentContextPath(db, row)),
        ),
      );
    },

    async listReviewableDrafts(input) {
      return listReviewableDraftRows(db, await requirePrimaryWorkId(db, input.threadId));
    },

    async listReviewableDraftsByWork(input) {
      return listReviewableDraftRows(db, input.workId);
    },

    async listActiveDraftsByWork(input) {
      const rows = await db
        .select({
          draft: documentYjsDrafts,
          documentName: documents.name,
          extension: documents.extension,
          folderId: documents.folderId,
        })
        .from(documentYjsDrafts)
        .leftJoin(documents, eq(documents.id, documentYjsDrafts.documentId))
        .where(
          and(eq(documentYjsDrafts.workId, input.workId), eq(documentYjsDrafts.status, "active")),
        )
        .orderBy(desc(documentYjsDrafts.updatedAt), asc(documentYjsDrafts.id));
      return Promise.all(
        rows.map(async (row) =>
          mapActiveDraft(row.draft, row.documentName, await documentContextPath(db, row)),
        ),
      );
    },

    async discardFailedResponseDrafts(input) {
      const workId = await requirePrimaryWorkId(db, input.threadId);
      await db.transaction(async (tx) => {
        const txDb = tx as DraftDb;
        const rows = await txDb
          .select({ draft: documentYjsDrafts, headDocumentId: documentYjsHeads.documentId })
          .from(documentYjsDrafts)
          .leftJoin(documentYjsHeads, eq(documentYjsHeads.documentId, documentYjsDrafts.documentId))
          .where(
            and(
              eq(documentYjsDrafts.workId, workId),
              eq(documentYjsDrafts.status, "active"),
              inArray(documentYjsDrafts.documentId, input.documentIds),
            ),
          );
        for (const row of rows) {
          await deleteDraftState(txDb, {
            documentId: row.draft.documentId as DocumentId,
            draftId: row.draft.id,
          });
          await txDb
            .delete(documentYjsDraftUpdates)
            .where(eq(documentYjsDraftUpdates.draftId, row.draft.id));
          await txDb.delete(documentYjsDrafts).where(eq(documentYjsDrafts.id, row.draft.id));
          if (!row.draft.createdDocument && row.headDocumentId === null) {
            await txDb.delete(documents).where(eq(documents.id, row.draft.documentId));
          }
        }
      });
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
            workId: await requirePrimaryWorkId(db, input.threadId),
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
        const txDb = tx as DraftDb;
        const updated = await txDb
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

        await txDb.insert(documentYjsDraftUpdates).values({
          draftId: input.draftId,
          updateData: Buffer.from(input.updateData),
          actorUserId: input.actorUserId ?? null,
          actorTurnId: input.actorTurnId ?? null,
        });
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

    async markDraftCreatedDocument(input) {
      await db
        .update(documentYjsDrafts)
        .set({ createdDocument: true, updatedAt: sql`now()` })
        .where(
          and(
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, input.threadId)),
            eq(documentYjsDrafts.status, "active"),
          ),
        );
    },

    async beginAccept(input) {
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
            eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, input.threadId)),
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
      if (row) {
        const draft = mapDraft(row);
        if (!draft.claimToken) throw new Error(`Claimed draft ${draft.id} missing claim token`);
        return {
          status: "claimed",
          draft,
          lease: {
            documentId: draft.documentId,
            workId: draft.workId,
            draftId: draft.id,
            id: draft.claimToken,
          },
        };
      }

      const [accepting] = await db
        .select()
        .from(documentYjsDrafts)
        .where(
          and(
            eq(documentYjsDrafts.id, input.draftId),
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, input.threadId)),
            eq(documentYjsDrafts.status, "accepting"),
          ),
        )
        .limit(1);
      if (accepting) return { status: "in_progress", draft: mapDraft(accepting) };

      const [applied] = await db
        .select()
        .from(documentYjsDrafts)
        .where(
          and(
            eq(documentYjsDrafts.id, input.draftId),
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, input.threadId)),
            eq(documentYjsDrafts.status, "applied"),
          ),
        )
        .limit(1);
      const appliedDraft = applied ? mapDraft(applied) : null;
      if (appliedDraft && appliedDraft.appliedUpdateSeq !== null) {
        const draft: AppliedDraft = {
          ...appliedDraft,
          appliedUpdateSeq: appliedDraft.appliedUpdateSeq,
        };
        return { status: "already_applied", draft };
      }
      return { status: "not_found" };
    },

    async releaseAccept(lease) {
      const rows = await db
        .update(documentYjsDrafts)
        .set({
          status: "active",
          claimedAt: null,
          claimToken: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(documentYjsDrafts.id, lease.draftId),
            eq(documentYjsDrafts.documentId, lease.documentId),
            eq(documentYjsDrafts.workId, lease.workId),
            eq(documentYjsDrafts.status, "accepting"),
            eq(documentYjsDrafts.claimToken, lease.id),
          ),
        )
        .returning({ id: documentYjsDrafts.id });
      return rows.length > 0;
    },

    async reject(input) {
      if (input.acceptLease) {
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
              eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, input.threadId)),
              eq(documentYjsDrafts.status, "accepting"),
              eq(documentYjsDrafts.claimToken, input.acceptLease.id),
            ),
          )
          .returning();
        if (!row) return null;
        await deleteDraftState(db, input);
        return mapDraft(row);
      }

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
            eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, input.threadId)),
            eq(documentYjsDrafts.status, "active"),
            or(
              isNull(documentYjsDrafts.claimedAt),
              sql`${documentYjsDrafts.claimedAt} < now() - interval '10 minutes'`,
            ),
          ),
        )
        .returning();
      if (!row) return null;
      await deleteDraftState(db, input);
      return mapDraft(row);
    },

    async reactivate(input) {
      try {
        const [row] = await db
          .update(documentYjsDrafts)
          .set({
            status: "active",
            appliedAt: null,
            appliedByUserId: null,
            appliedUpdateSeq: null,
            discardedAt: null,
            claimedAt: null,
            claimToken: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(documentYjsDrafts.id, input.draftId),
              eq(documentYjsDrafts.documentId, input.documentId),
              eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, input.threadId)),
              eq(documentYjsDrafts.status, input.fromStatus),
            ),
          )
          .returning();
        return row ? mapDraft(row) : null;
      } catch (cause) {
        if (isUniqueViolation(cause, ACTIVE_DRAFT_UNIQUE_CONSTRAINT)) return null;
        throw cause;
      }
    },

    async completeAccept(input) {
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
            eq(documentYjsDrafts.id, input.lease.draftId),
            eq(documentYjsDrafts.status, "accepting"),
            eq(documentYjsDrafts.claimToken, input.lease.id),
          ),
        )
        .returning({ id: documentYjsDrafts.id });
      if (row.length === 0) return false;
      await deleteDraftState(db, input.lease);
      return true;
    },

    async recoverAccepted(input) {
      await deleteDraftState(db, input);
    },

    async deleteCreatedDraftDocument(input) {
      const [row] = await db
        .select({ id: documents.id })
        .from(documentYjsDrafts)
        .innerJoin(documents, eq(documents.id, documentYjsDrafts.documentId))
        .where(
          and(
            eq(documentYjsDrafts.id, input.draftId),
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, input.threadId)),
            eq(documentYjsDrafts.createdDocument, true),
          ),
        )
        .limit(1);
      if (!row) return;
      await db.delete(documents).where(eq(documents.id, input.documentId));
    },
  };
}

async function listReviewableDraftRows(db: DraftDb, workId: WorkId): Promise<ReviewableDraft[]> {
  const retentionCutoff = sql`now() - interval '1 day'`;
  const rows = await db
    .select({
      draft: documentYjsDrafts,
      documentName: documents.name,
      extension: documents.extension,
      folderId: documents.folderId,
    })
    .from(documentYjsDrafts)
    .leftJoin(documents, eq(documents.id, documentYjsDrafts.documentId))
    .where(
      and(
        eq(documentYjsDrafts.workId, workId),
        or(
          eq(documentYjsDrafts.status, "active"),
          and(
            eq(documentYjsDrafts.status, "applied"),
            sql`${documentYjsDrafts.appliedAt} > ${retentionCutoff}`,
          ),
          and(
            eq(documentYjsDrafts.status, "discarded"),
            sql`${documentYjsDrafts.discardedAt} > ${retentionCutoff}`,
          ),
        ),
      ),
    )
    .orderBy(desc(documentYjsDrafts.updatedAt), asc(documentYjsDrafts.id));
  return Promise.all(
    rows.map(async (row) =>
      mapReviewableDraft(row.draft, row.documentName, await documentContextPath(db, row)),
    ),
  );
}

async function deleteDraftState(
  db: DraftDb,
  input: { documentId: DocumentId; draftId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const txDb = tx as DraftDb;
    const draftScope = { documentId: input.documentId, scopeId: input.draftId };
    await txDb.delete(agentEditSyncState).where(scopeOnlyWhere(agentEditSyncState, draftScope));
    await txDb.delete(documentYjsReversals).where(scopeOnlyWhere(documentYjsReversals, draftScope));
    await txDb.delete(agentEditMutations).where(scopeOnlyWhere(agentEditMutations, draftScope));
    await txDb.delete(agentEditWidCounters).where(scopeOnlyWhere(agentEditWidCounters, draftScope));
  });
}

async function resolvePrimaryWorkId(
  db: Pick<Database, "select">,
  threadId: ThreadId,
): Promise<WorkId | null> {
  const [row] = await db
    .select({ workId: threadWorks.workId })
    .from(threadWorks)
    .where(and(eq(threadWorks.threadId, threadId), eq(threadWorks.isPrimary, true)))
    .limit(1);
  return (row?.workId as WorkId | undefined) ?? null;
}

async function requirePrimaryWorkId(
  db: Pick<Database, "select">,
  threadId: ThreadId,
): Promise<WorkId> {
  const workId = await resolvePrimaryWorkId(db, threadId);
  if (!workId) throw new Error(`Thread ${threadId} has no primary work`);
  return workId;
}

function scopeOnlyWhere(
  table: { documentId: unknown; scopeId: unknown },
  input: { documentId: DocumentId; scopeId: string },
) {
  return and(
    eq(table.documentId as never, input.documentId),
    eq(table.scopeId as never, input.scopeId),
  );
}

export function createDrizzleDraftAcceptJournal(db: DraftDb): DraftAcceptJournal {
  return {
    findAcceptedDraftAppend: (input) => findAcceptedDraftAppend(db, input),
    async appendAcceptedDraft(input) {
      return db.transaction(async (tx) => {
        const txDb = tx as DraftDb;
        if (input.actorTurnId) {
          await insertDraftAcceptTurn(txDb, { ...input, actorTurnId: input.actorTurnId });
        }
        const existing = await findAcceptedDraftAppend(txDb, input);
        if (existing) return existing;

        const txJournal = createDrizzleJournal(tx as Parameters<typeof createDrizzleJournal>[0]);
        const [result] = await txJournal.appendBatch([
          {
            docId: input.documentId,
            update: input.update,
            meta: {
              origin: "system",
              actorTurnId: input.actorTurnId ?? input.acceptTurnId,
              seq: 0,
            },
            mutation: {
              threadId: input.threadId,
              turnId: input.acceptTurnId,
              writeId: input.writeId,
            },
          },
        ]);
        if (!result) throw new Error(`Failed to append accepted draft ${input.draftId}`);
        return {
          appliedUpdateSeq: result.seq,
          acceptTurnId: input.acceptTurnId,
          threadId: input.threadId,
        };
      });
    },
    async createRejectTurn(input) {
      return db.transaction(async (tx) => {
        await insertDraftRejectTurn(tx as DraftDb, input);
      });
    },
  };
}

async function findAcceptedDraftAppend(
  db: Pick<Database, "select">,
  input: { documentId: DocumentId; threadId: ThreadId; writeId: string },
): Promise<AcceptedDraftAppend | null> {
  const [row] = await db
    .select({
      createdSeq: agentEditMutations.createdSeq,
      turnId: agentEditMutations.turnId,
      threadId: agentEditMutations.threadId,
    })
    .from(agentEditMutations)
    .where(
      and(
        eq(agentEditMutations.documentId, input.documentId),
        eq(agentEditMutations.scopeId, LIVE_SCOPE),
        eq(agentEditMutations.writeId, input.writeId),
      ),
    )
    .limit(1);
  return row
    ? {
        appliedUpdateSeq: Number(row.createdSeq),
        acceptTurnId: row.turnId,
        threadId: row.threadId as ThreadId,
      }
    : null;
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
        documentName: input.documentName ?? null,
        wIdRange: input.wIdRange ?? null,
      }),
      completedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing({ target: turns.id });

  const text = formatDraftAcceptTurnText(input.documentName ?? null);

  await db
    .insert(turnBlocks)
    .values({
      id: input.acceptBlockId,
      turnId: input.acceptTurnId,
      blockType: "text",
      status: "complete",
      sequence: 0,
      modelText: text,
      content: text,
      compact: "",
    })
    .onConflictDoNothing({ target: turnBlocks.id });

  await advanceThreadLeafWithReparent(db, {
    threadId: input.threadId,
    newLeafTurnId: input.acceptTurnId,
    fallbackParentTurnId: input.actorTurnId,
    now,
  });
}

async function insertDraftRejectTurn(
  db: DraftDb,
  input: Parameters<DraftAcceptJournal["createRejectTurn"]>[0],
): Promise<void> {
  const now = new Date();
  const [thread] = await db
    .select({ activeLeafTurnId: threads.activeLeafTurnId })
    .from(threads)
    .where(eq(threads.id, input.threadId))
    .limit(1);
  const parentTurnId = thread?.activeLeafTurnId ?? input.actorTurnId;
  const text = formatDraftRejectTurnText(input.documentName);

  await db
    .insert(turns)
    .values({
      id: input.rejectTurnId,
      threadId: input.threadId,
      parentTurnId,
      role: "user",
      status: "complete",
      finishReason: "end_turn",
      requestParams: draftRejectTurnRequestParams({
        draftId: input.draftId,
        documentId: input.documentId,
        documentName: input.documentName,
        wIdRange: input.wIdRange,
      }),
      completedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing({ target: turns.id });

  await db
    .insert(turnBlocks)
    .values({
      id: input.rejectBlockId,
      turnId: input.rejectTurnId,
      blockType: "text",
      status: "complete",
      sequence: 0,
      modelText: text,
      content: text,
      compact: "",
    })
    .onConflictDoNothing({ target: turnBlocks.id });

  await advanceThreadLeafWithReparent(db, {
    threadId: input.threadId,
    newLeafTurnId: input.rejectTurnId,
    fallbackParentTurnId: input.actorTurnId,
    now,
  });
}

async function advanceThreadLeafWithReparent(
  db: DraftDb,
  input: {
    threadId: ThreadId;
    newLeafTurnId: TurnId;
    fallbackParentTurnId: TurnId | null;
    now: Date;
  },
): Promise<void> {
  let expectedLeaf = input.fallbackParentTurnId;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [thread] = await db
      .select({ activeLeafTurnId: threads.activeLeafTurnId })
      .from(threads)
      .where(eq(threads.id, input.threadId))
      .limit(1);
    const parentTurnId = thread?.activeLeafTurnId ?? input.fallbackParentTurnId;
    if (parentTurnId !== expectedLeaf) {
      await db.update(turns).set({ parentTurnId }).where(eq(turns.id, input.newLeafTurnId));
      expectedLeaf = parentTurnId;
    }
    const updated = await db
      .update(threads)
      .set({ activeLeafTurnId: input.newLeafTurnId, updatedAt: input.now })
      .where(
        and(
          eq(threads.id, input.threadId),
          expectedLeaf === null
            ? isNull(threads.activeLeafTurnId)
            : eq(threads.activeLeafTurnId, expectedLeaf),
        ),
      )
      .returning({ id: threads.id });
    if (updated.length > 0) return;
  }

  const [thread] = await db
    .select({ activeLeafTurnId: threads.activeLeafTurnId })
    .from(threads)
    .where(eq(threads.id, input.threadId))
    .limit(1);
  const parentTurnId = thread?.activeLeafTurnId ?? input.fallbackParentTurnId;
  await db.update(turns).set({ parentTurnId }).where(eq(turns.id, input.newLeafTurnId));
  const updated = await db
    .update(threads)
    .set({ activeLeafTurnId: input.newLeafTurnId, updatedAt: input.now })
    .where(
      and(
        eq(threads.id, input.threadId),
        parentTurnId === null
          ? isNull(threads.activeLeafTurnId)
          : eq(threads.activeLeafTurnId, parentTurnId),
      ),
    )
    .returning({ id: threads.id });
  if (updated.length === 0)
    throw new Error(`Thread ${input.threadId} advanced while inserting draft turn`);
}

function mapDraft(row: typeof documentYjsDrafts.$inferSelect): Draft {
  return {
    id: row.id,
    documentId: row.documentId as DocumentId,
    workId: row.workId as WorkId,
    status: row.status,
    baseLiveUpdateSeq: Number(row.baseLiveUpdateSeq),
    createdDocument: row.createdDocument,
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
  contextPath: string | null,
): ActiveDraft {
  const draft = mapDraft(row);
  if (draft.status !== "active") throw new Error(`Expected active draft: ${draft.id}`);
  return { ...draft, status: draft.status, documentName, contextPath };
}

function mapReviewableDraft(
  row: typeof documentYjsDrafts.$inferSelect,
  documentName: string | null,
  contextPath: string | null,
): ReviewableDraft {
  const draft = mapDraft(row);
  if (draft.status !== "active" && draft.status !== "applied" && draft.status !== "discarded") {
    throw new Error(`Expected reviewable draft: ${draft.id}`);
  }
  return { ...draft, status: draft.status, documentName, contextPath };
}

async function documentContextPath(
  db: Pick<Database, "select">,
  row: { extension: string | null; folderId: string | null; documentName: string | null },
): Promise<string | null> {
  if (!row.documentName) return null;
  const folderPath = await resolveFolderPath(db, row.folderId);
  const filename = row.extension ? `${row.documentName}.${row.extension}` : row.documentName;
  return `/${[...folderPath, filename].join("/")}`;
}

async function resolveFolderPath(
  db: Pick<Database, "select">,
  folderId: string | null,
): Promise<string[]> {
  const names: string[] = [];
  let current = folderId;
  while (current !== null) {
    const [folder] = await db
      .select({ parentId: folders.parentId, name: folders.name })
      .from(folders)
      .where(eq(folders.id, current as typeof folders.$inferSelect.id))
      .limit(1);
    if (!folder) break;
    names.unshift(folder.name);
    current = folder.parentId;
  }
  return names;
}

function mapDraftUpdate(row: typeof documentYjsDraftUpdates.$inferSelect): DraftUpdate {
  return {
    id: row.id,
    draftId: row.draftId,
    updateData: new Uint8Array(row.updateData),
    actorUserId: (row.actorUserId as UserId | null) ?? null,
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
