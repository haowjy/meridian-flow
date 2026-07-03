/** Drizzle adapter for persisted collab draft review state. */

import { randomUUID } from "node:crypto";
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
  threadWorks,
  turns,
} from "@meridian/database";
import { and, asc, desc, eq, inArray, isNull, max, or, sql } from "drizzle-orm";
import type {
  ActiveDraft,
  Draft,
  DraftLifecycleEvent,
  DraftStore,
  DraftUpdate,
  ReviewableDraft,
} from "../domain/drafts.js";
import { ActiveDraftConflictError, createDraftId } from "../domain/drafts.js";

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

    async resolvePrimaryThreadForWork(workId) {
      const [row] = await db
        .select({ threadId: threadWorks.threadId })
        .from(threadWorks)
        .where(and(eq(threadWorks.workId, workId), eq(threadWorks.isPrimary, true)))
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

    async listLifecycleEventsByWorkSince(input) {
      const rows = await db
        .select({ draft: documentYjsDrafts, documentName: documents.name })
        .from(documentYjsDrafts)
        .leftJoin(documents, eq(documents.id, documentYjsDrafts.documentId))
        .where(eq(documentYjsDrafts.workId, input.workId))
        .orderBy(asc(documentYjsDrafts.updatedAt), asc(documentYjsDrafts.id));
      const events: DraftLifecycleEvent[] = [];
      for (const row of rows) {
        const draft = mapDraft(row.draft);
        const base = {
          draftId: draft.id,
          documentId: draft.documentId,
          documentName: row.documentName,
        };
        if (draft.status === "applied" && draft.appliedAt) {
          if (!input.since || draft.appliedAt >= input.since) {
            events.push({ ...base, status: "applied", occurredAt: draft.appliedAt });
          }
        } else if (draft.status === "discarded" && draft.discardedAt) {
          if (!input.since || draft.discardedAt >= input.since) {
            events.push({ ...base, status: "discarded", occurredAt: draft.discardedAt });
          }
        } else if (draft.status === "active" && draft.undoneAt) {
          if (!input.since || draft.undoneAt >= input.since) {
            events.push({ ...base, status: "undone", occurredAt: draft.undoneAt });
          }
        }
      }
      return events;
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
          const [{ liveUpdateCount } = { liveUpdateCount: 0 }] = await txDb
            .select({ liveUpdateCount: sql<number>`count(*)::int` })
            .from(documentYjsUpdates)
            .where(eq(documentYjsUpdates.documentId, row.draft.documentId));
          if (
            row.draft.createdDocument ||
            (row.draft.baseLiveUpdateSeq === 0 && liveUpdateCount === 0)
          ) {
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

    async claimMutation(input) {
      const workId = await requirePrimaryWorkId(db, input.threadId);
      const token = randomUUID();
      const claimedStatus = claimedStatusForKind(input.kind);
      try {
        const [row] = await db
          .update(documentYjsDrafts)
          .set({
            status: claimedStatus,
            claimedAt: sql`now()`,
            claimToken: token,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(documentYjsDrafts.id, input.draftId),
              eq(documentYjsDrafts.documentId, input.documentId),
              eq(documentYjsDrafts.workId, workId),
              or(
                ...input.fromStatuses.map((status) => eq(documentYjsDrafts.status, status)),
                and(
                  eq(documentYjsDrafts.status, claimedStatus),
                  or(
                    isNull(documentYjsDrafts.claimedAt),
                    sql`${documentYjsDrafts.claimedAt} < now() - interval '10 minutes'`,
                  ),
                ),
              ),
            ),
          )
          .returning();
        if (row) {
          const draft = mapDraft(row);
          const restoreStatus = input.fromStatuses.includes(draft.status)
            ? draft.status
            : input.fromStatuses[0];
          if (!restoreStatus) throw new Error(`Claim ${input.kind} missing restore status`);
          return {
            status: "claimed",
            draft,
            lease: {
              kind: input.kind,
              documentId: draft.documentId,
              workId: draft.workId,
              draftId: draft.id,
              id: token,
              restoreStatus,
            },
          };
        }
      } catch (cause) {
        if (isUniqueViolation(cause, ACTIVE_DRAFT_UNIQUE_CONSTRAINT)) {
          return { status: "conflict" };
        }
        throw cause;
      }

      const [existing] = await db
        .select()
        .from(documentYjsDrafts)
        .where(
          and(
            eq(documentYjsDrafts.id, input.draftId),
            eq(documentYjsDrafts.documentId, input.documentId),
            eq(documentYjsDrafts.workId, workId),
          ),
        )
        .limit(1);
      if (existing?.status === claimedStatus)
        return { status: "in_progress", draft: mapDraft(existing) };
      return { status: "not_found" };
    },

    async abortClaimedMutation(input) {
      const [row] = await db
        .update(documentYjsDrafts)
        .set({
          status: input.restoreStatus ?? input.lease.restoreStatus,
          claimedAt: null,
          claimToken: null,
          updatedAt: sql`now()`,
        })
        .where(claimedMutationWhere(input.lease))
        .returning();
      return row ? mapDraft(row) : null;
    },

    async finishClaimedMutation(input) {
      if (input.targetStatus === "active") {
        try {
          return await db.transaction(async (tx) => {
            const txDb = tx as DraftDb;
            const [row] = await txDb
              .update(documentYjsDrafts)
              .set({
                status: "active",
                baseLiveUpdateSeq: input.baseLiveUpdateSeq ?? 0,
                acceptGeneration: sql`${documentYjsDrafts.acceptGeneration} + 1`,
                appliedAt: null,
                appliedByUserId: null,
                appliedUpdateSeq: null,
                discardedAt: null,
                undoneAt: sql`now()`,
                claimedAt: null,
                claimToken: null,
                updatedAt: sql`now()`,
              })
              .where(claimedMutationWhere(input.lease))
              .returning();
            if (!row) return null;
            await txDb
              .delete(documentYjsDraftUpdates)
              .where(eq(documentYjsDraftUpdates.draftId, input.lease.draftId));
            if ((input.updates ?? []).length > 0) {
              await txDb.insert(documentYjsDraftUpdates).values(
                (input.updates ?? []).map((update) => ({
                  draftId: input.lease.draftId,
                  updateData: Buffer.from(update.updateData),
                  actorUserId: update.actorUserId ?? null,
                  actorTurnId: update.actorTurnId ?? null,
                })),
              );
            }
            return mapDraft(row);
          });
        } catch (cause) {
          if (isUniqueViolation(cause, ACTIVE_DRAFT_UNIQUE_CONSTRAINT)) return null;
          throw cause;
        }
      }

      const values =
        input.targetStatus === "applied"
          ? {
              status: "applied" as const,
              appliedAt: sql`now()`,
              appliedByUserId: input.appliedByUserId,
              appliedUpdateSeq: input.appliedUpdateSeq,
              undoneAt: null,
              claimedAt: null,
              claimToken: null,
              updatedAt: sql`now()`,
            }
          : {
              status: "discarded" as const,
              discardedAt: sql`now()`,
              undoneAt: null,
              claimedAt: null,
              claimToken: null,
              updatedAt: sql`now()`,
            };
      const [row] = await db
        .update(documentYjsDrafts)
        .set(values)
        .where(claimedMutationWhere(input.lease))
        .returning();
      if (!row) return null;
      await deleteDraftState(db, input.lease);
      return mapDraft(row);
    },

    async reject(input) {
      if (input.lease) {
        const [row] = await db
          .update(documentYjsDrafts)
          .set({
            status: "discarded",
            discardedAt: sql`now()`,
            undoneAt: null,
            claimedAt: null,
            claimToken: null,
            updatedAt: sql`now()`,
          })
          .where(claimedMutationWhere(input.lease))
          .returning();
        if (!row) return null;
        await deleteDraftState(db, input.lease);
        return mapDraft(row);
      }

      const [row] = await db
        .update(documentYjsDrafts)
        .set({
          status: "discarded",
          discardedAt: sql`now()`,
          undoneAt: null,
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
            discardedAt: null,
            undoneAt: sql`now()`,
            claimedAt: null,
            claimToken: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(documentYjsDrafts.id, input.draftId),
              eq(documentYjsDrafts.documentId, input.documentId),
              eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, input.threadId)),
              eq(documentYjsDrafts.status, "discarded"),
            ),
          )
          .returning();
        return row ? mapDraft(row) : null;
      } catch (cause) {
        if (isUniqueViolation(cause, ACTIVE_DRAFT_UNIQUE_CONSTRAINT)) return null;
        throw cause;
      }
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

function claimedStatusForKind(kind: "accept" | "reactivation"): "accepting" | "reactivating" {
  return kind === "accept" ? "accepting" : "reactivating";
}

function claimedMutationWhere(lease: {
  kind: "accept" | "reactivation";
  documentId: DocumentId;
  workId: WorkId;
  draftId: string;
  id: string;
}) {
  return and(
    eq(documentYjsDrafts.id, lease.draftId),
    eq(documentYjsDrafts.documentId, lease.documentId),
    eq(documentYjsDrafts.workId, lease.workId),
    eq(documentYjsDrafts.status, claimedStatusForKind(lease.kind)),
    eq(documentYjsDrafts.claimToken, lease.id),
  );
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

function mapDraft(row: typeof documentYjsDrafts.$inferSelect): Draft {
  return {
    id: row.id,
    documentId: row.documentId as DocumentId,
    workId: row.workId as WorkId,
    status: row.status,
    baseLiveUpdateSeq: Number(row.baseLiveUpdateSeq),
    acceptGeneration: row.acceptGeneration,
    createdDocument: row.createdDocument,
    lastActorTurnId: (row.lastActorTurnId as TurnId | null) ?? null,
    appliedAt: row.appliedAt,
    appliedByUserId: (row.appliedByUserId as UserId | null) ?? null,
    appliedUpdateSeq: row.appliedUpdateSeq === null ? null : Number(row.appliedUpdateSeq),
    discardedAt: row.discardedAt,
    undoneAt: row.undoneAt,
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
