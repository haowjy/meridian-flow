/** Drizzle store for durable branch pushes into the live Yjs journal. */
import { randomUUID } from "node:crypto";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branches,
  branchPushSettlementBatches,
  branchPushSettlementPayloads,
  documentDrafts,
  documentEditParts,
  documentEdits,
  draftWriteJournal,
  pushLineage,
  works,
} from "@meridian/database/schema";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { bumpDraftRevisions } from "../../../shared/draft-revisions.js";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { draftBranchWork } from "../../../shared/work-branch-lifecycle.js";
import { livingDocumentUses } from "../../context/tree/tree-view.js";
import type { NoticePort } from "../../notices/index.js";
import { WorkLifecycleUnavailableError } from "../../projects/domain/work-lifecycle.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { BranchCommandExistsError } from "../domain/branch-commands.js";
import {
  BranchPushCommitConflictError,
  type BranchPushReadStore,
  DraftChangeRefusal,
  type PreparedDiscardCommit,
  type PreparedPushCommit,
  type PushCommitStore,
  type PushLineageRow,
} from "../domain/branch-push-contracts.js";
import { BRANCH_TREE_STEP } from "../domain/branch-tree-payload.js";
import type { DraftJournalRow } from "../domain/draft-journal.js";
import { persistDurableTrailRecords } from "../domain/draft-trail-projection.js";
import type { ChangeTrailPersistence } from "../domain/ports/change-trail-persistence.js";
import type {
  WorkBranchPendingEvidence,
  WorkBranchPendingStore,
} from "../domain/ports/work-branch-pending-store.js";
import { attachBatchWithinTx, claimCommandWithinTx } from "./drizzle-branch-commands.js";
import { readHeadRevision } from "./drizzle-document-authority-head.js";
import { placeDraftRows } from "./drizzle-document-edits.js";
import { refreshDraftEffect } from "./drizzle-draft-effect.js";
import { commitRewriteWithinTx } from "./drizzle-draft-storage.js";
import {
  assertRootOwnedSettlement,
  type StageSettlementBatchWithinTx,
} from "./drizzle-pending-settlement.js";

/** Global lock order for multi-document push batches — matches journal appendBatch. */
export function sortPushesByDocumentId<T extends { documentDraft: { documentId: string } }>(
  pushes: readonly T[],
): T[] {
  return [...pushes].sort((left, right) =>
    left.documentDraft.documentId.localeCompare(right.documentDraft.documentId),
  );
}

export function createDrizzleDraftJournalReadStore(db: Database): BranchPushReadStore {
  return {
    async listActiveJournalRows(draftId, generation) {
      const rows = await db
        .select()
        .from(draftWriteJournal)
        .where(
          and(
            eq(draftWriteJournal.draftId, draftId),
            eq(draftWriteJournal.generation, generation),
            eq(draftWriteJournal.status, "active"),
          ),
        )
        .orderBy(draftWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async listReviewableJournalRows(draftId, generation) {
      const rows = await db
        .select()
        .from(draftWriteJournal)
        .where(
          and(
            eq(draftWriteJournal.draftId, draftId),
            eq(draftWriteJournal.generation, generation),
            inArray(draftWriteJournal.status, ["active", "rollback_pending"]),
          ),
        )
        .orderBy(draftWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async listJournalRowsForTurn(input) {
      const conditions = [
        eq(draftWriteJournal.threadId, input.threadId),
        eq(draftWriteJournal.turnId, input.turnId),
      ];
      if (input.draftId) conditions.push(eq(draftWriteJournal.draftId, input.draftId));
      if (input.generation !== undefined) {
        conditions.push(eq(draftWriteJournal.generation, input.generation));
      }
      if (input.statuses && input.statuses.length > 0) {
        conditions.push(inArray(draftWriteJournal.status, [...input.statuses]));
      }
      const rows = await db
        .select()
        .from(draftWriteJournal)
        .where(and(...conditions))
        .orderBy(draftWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async listJournalRowsForDraft(input) {
      const conditions = [
        eq(draftWriteJournal.draftId, input.draftId),
        eq(draftWriteJournal.generation, input.generation),
      ];
      if (input.throughJournalId !== undefined) {
        conditions.push(sql`${draftWriteJournal.id} <= ${input.throughJournalId}`);
      }
      const rows = await currentDrizzleDb(db)
        .select({
          row: draftWriteJournal,
          editKind: documentEdits.kind,
        })
        .from(draftWriteJournal)
        .leftJoin(
          documentEditParts,
          sql`
          ${documentEditParts.origin}->>'kind' = 'pending'
          and ${documentEditParts.origin}->>'draftId' = ${draftWriteJournal.draftId}::text
          and ${documentEditParts.origin}->>'generation' = ${draftWriteJournal.generation}::text
          and ${documentEditParts.origin}->>'rowId' = ${draftWriteJournal.id}::text
        `,
        )
        .leftJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
        .where(and(...conditions))
        .orderBy(draftWriteJournal.id);
      // A row can carry several parts of one edit: one entry per row, in journal order.
      const byRow = new Map<number, ReturnType<typeof mapJournalRow>>();
      for (const { row, editKind } of rows) {
        const seen = byRow.get(row.id);
        if (!seen || (!seen.editKind && editKind)) {
          byRow.set(row.id, { ...mapJournalRow(row), ...(editKind ? { editKind } : {}) });
        }
      }
      return [...byRow.values()];
    },

    async listPushLineageForTurn(input) {
      const turnRows = await db
        .select({ id: draftWriteJournal.id })
        .from(draftWriteJournal)
        .where(
          and(
            eq(draftWriteJournal.threadId, input.threadId),
            eq(draftWriteJournal.turnId, input.turnId),
          ),
        );
      const journalIds = turnRows.map((row) => row.id);
      const directCondition = and(
        eq(pushLineage.threadId, input.threadId),
        eq(pushLineage.turnId, input.turnId),
      );
      const rows = await db
        .select()
        .from(pushLineage)
        .where(
          journalIds.length > 0
            ? sql`(${pushLineage.threadId} = ${input.threadId} AND ${pushLineage.turnId} = ${input.turnId}) OR ${pushLineage.journalIds} && ARRAY[${sql.join(journalIds, sql`, `)}]::bigint[]`
            : directCondition,
        )
        .orderBy(pushLineage.id);
      return rows.map(mapLineage);
    },

    async listConcurrentJournalRows(draftId, generation, options) {
      const floor = options.afterJournalId ?? 0;
      // A save's attribution reads inside its own transaction: the root pool handle would
      // wait on another connection and miss that transaction's uncommitted rows.
      const rows = await currentDrizzleDb(db)
        .select({ row: draftWriteJournal })
        .from(draftWriteJournal)
        .innerJoin(documentDrafts, eq(draftWriteJournal.draftId, documentDrafts.id))
        .where(
          and(
            eq(documentDrafts.documentId, options.documentId),
            sql`${draftWriteJournal.id} > ${floor}`,
            // Same-draft active rows and cross-draft pushed rows are both needed for
            // attribution. Cold-start scans are deliberately unbounded until we add a
            // push-ordered floor; max(journal.id) is unsound because journal ids can include
            // unpushed sibling rows and do not encode push order. Each row remains bounded
            // by its owning draft generation so reset/future-generation rows cannot leak
            // backward.
            sql`(
              (${draftWriteJournal.draftId} = ${draftId}
                AND ${draftWriteJournal.generation} <= ${generation}
                AND ${draftWriteJournal.status} IN ('active', 'pushed'))
              OR (${draftWriteJournal.draftId} <> ${draftId}
                AND ${draftWriteJournal.generation} <= ${documentDrafts.generation}
                AND ${draftWriteJournal.status} = 'pushed')
            )`,
          ),
        )
        .orderBy(draftWriteJournal.id);
      return rows.map(({ row }) => mapJournalRow(row));
    },

    async latestPushForDraft(draftId, generation) {
      const [row] = await db
        .select()
        .from(pushLineage)
        .where(and(eq(pushLineage.draftId, draftId), eq(pushLineage.draftGeneration, generation)))
        .orderBy(sql`${pushLineage.id} DESC`)
        .limit(1);
      return row ? mapLineage(row) : null;
    },
  };
}

/** Thrown inside the staging transaction to roll back its command claim with it. */
/** A staged write's Works and its grants' Works, locked first; each of its own must be active. */
const ACTIVE_DRAFT_SEAM = { seam: true, requireActive: true } as const;

class LineageConflictAfterClaim extends Error {
  constructor(readonly push: PushLineageRow) {
    super("A lineage conflict ended staging after the command was claimed");
    this.name = "LineageConflictAfterClaim";
  }
}

export function createDrizzlePushCommitStore(
  db: Database,
  stageSettlementBatchWithinTx: StageSettlementBatchWithinTx,
  changeTrails: ChangeTrailPersistence,
  notices: NoticePort | undefined,
  workProjection: WorkProjectionMutation,
): PushCommitStore {
  return {
    async commitDiscard(input) {
      return workProjection.mutate(
        { drafts: [input.documentDraft.draftId] },
        () => commitPreparedDiscard(currentDrizzleDb(db), input, new Date()),
        ACTIVE_DRAFT_SEAM,
      );
    },

    async commitPushBatch(input) {
      assertRootOwnedSettlement("Branch push staging");
      const draftIds = input.pushes.map(({ documentDraft }) => documentDraft.draftId);
      const firstCommitted = async () => {
        for (const prepared of sortPushesByDocumentId(input.pushes)) {
          const existing = await findLineage(currentDrizzleDb(db), prepared.idempotencyKey);
          if (existing) return existing;
        }
        return null;
      };
      return workProjection
        .mutate(
          { drafts: draftIds },
          async () => {
            const txDb = currentDrizzleDb(db);
            // The command's claim is the transaction's first write; losing it stages nothing.
            if (input.command && !(await claimCommandWithinTx(txDb, input.command))) {
              return { status: "command_exists" as const };
            }
            const existing = await firstCommitted();
            // A claim with no batch can never settle: roll it back with this transaction and
            // let the caller's retry claim again (§4.6).
            if (existing && input.command) throw new LineageConflictAfterClaim(existing);
            if (existing) return { status: "conflict" as const, push: existing };
            const sorted = sortPushesByDocumentId(input.pushes);
            // Every document lock before any trail lock, as completion takes them.
            for (const prepared of sorted)
              await lockDocumentMutation(txDb, prepared.documentDraft.documentId);
            const now = new Date();
            const staged = [];
            for (const prepared of sorted) {
              staged.push({
                prepared,
                push: mapLineage(await commitPreparedPush(txDb, prepared, now)),
              });
            }
            // A durable commit requires its trail bundle: every push's, in one record.
            if (staged.length > 0) {
              await persistDurableTrailRecords(
                staged.map(({ prepared, push }) => ({ record: prepared.trail, push })),
                changeTrails,
                notices,
              );
            }
            await stageSettlementBatchWithinTx(
              txDb,
              input.settlement,
              staged,
              input.payloads,
              input.holds,
            );
            if (input.command) {
              await attachBatchWithinTx(txDb, input.command.commandId, input.settlement.batchId);
            }
            return { status: "inserted" as const, pushes: staged.map(({ push }) => push) };
          },
          ACTIVE_DRAFT_SEAM,
        )
        .catch(async (error: unknown) => {
          if (error instanceof LineageConflictAfterClaim) {
            return { status: "conflict" as const, push: error.push };
          }
          if (!(error instanceof WorkLifecycleUnavailableError)) throw error;
          // Archive can win after another process committed this exact attempt.
          // A durable receipt is history, not permission to perform another write.
          const existing = await firstCommitted();
          if (existing) return { status: "conflict" as const, push: existing };
          throw error;
        });
    },
  };
}

/**
 * The one SQL membership rule for a draft to count as a pending document, twin of
 * `branch-review-items.ts` (`hasRows && (hasEffect || blocking)`). The Work count and the
 * document hint both filter by it; the Works boundary reconciles each Work's stored count
 * through that count (migration 0067's backfill spells it in SQL too).
 */
const reviewableWorkDraft = and(
  eq(documentDrafts.kind, "work_draft"),
  eq(documentDrafts.status, "active"),
  sql`(${documentDrafts.hasEffect} OR ${documentDrafts.blocking})`,
  sql`exists (
    select 1 from ${draftWriteJournal}
    where ${draftWriteJournal.draftId} = ${documentDrafts.id}
      and ${draftWriteJournal.generation} = ${documentDrafts.generation}
      and ${draftWriteJournal.status} in ('active', 'rollback_pending'))`,
);

export function createDrizzleWorkBranchPendingStore(db: Database): WorkBranchPendingStore {
  return {
    async countPendingByWorkIds(workIds) {
      if (workIds.length === 0) return new Map();
      const tx = currentDrizzleDb(db);
      const branchTreeChanges = livingDocumentUses(tx);
      const drafted = tx
        .select({ workId: draftBranchWork.workId, documentId: documentDrafts.documentId })
        .from(documentDrafts)
        .innerJoin(draftBranchWork.branches, draftBranchWork.on)
        .where(
          and(
            inArray(draftBranchWork.workId, workIds),
            eq(branches.status, "active"),
            reviewableWorkDraft,
          ),
        );
      // A created document is pending with no text yet (a draftless image, an empty create).
      const changed = tx
        .select({ workId: branches.originWorkId, documentId: branchTreeChanges.nodeId })
        .from(branchTreeChanges)
        .innerJoin(branches, eq(branches.id, branchTreeChanges.branchId))
        .where(
          and(
            inArray(branches.originWorkId, workIds),
            eq(branches.status, "active"),
            eq(branchTreeChanges.nodeKind, "document"),
          ),
        );
      // `union` (not `union all`) leaves each Work's document once, so a row is a document.
      const pending = drafted.union(changed).as("pending");
      const rows = await tx
        .select({ workId: pending.workId, count: sql<number>`count(*)::int` })
        .from(pending)
        .groupBy(pending.workId);
      return new Map(
        rows.flatMap(({ workId, count }) => (workId ? [[workId as WorkId, count]] : [])),
      );
    },
    async listBranchesChangingDocument({ projectId, documentId }) {
      const tx = currentDrizzleDb(db);
      const branchTreeChanges = livingDocumentUses(tx);
      // The same membership arms as the Work counts, narrowed to one document.
      const drafted = tx
        .select({ branchId: documentDrafts.branchId })
        .from(documentDrafts)
        .where(and(eq(documentDrafts.documentId, documentId), reviewableWorkDraft));
      const changed = tx
        .select({ branchId: branchTreeChanges.branchId })
        .from(branchTreeChanges)
        .where(
          and(eq(branchTreeChanges.nodeId, documentId), eq(branchTreeChanges.nodeKind, "document")),
        );
      // Archived Works stay (their branches remain reviewable); deleted Works and branches whose
      // origin Work is gone are out, since today's review address needs a live Work.
      const rows = await tx
        .select({
          branchId: branches.id,
          originWorkId: works.id,
          name: works.name,
          isNoWork: works.isNoWork,
        })
        .from(branches)
        .innerJoin(works, eq(works.id, branches.originWorkId))
        .where(
          and(
            eq(branches.projectId, projectId),
            eq(branches.status, "active"),
            isNull(works.deletedAt),
            sql`${branches.id} in (${drafted.union(changed)})`,
          ),
        )
        .orderBy(asc(branches.createdAt), asc(branches.id));
      return rows.map((row) => ({
        branchId: row.branchId,
        originWorkId: row.originWorkId,
        originWorkName: row.isNoWork ? null : row.name,
      }));
    },
    async listCreators(branchId, documentIds) {
      const branchTreeChanges = livingDocumentUses(currentDrizzleDb(db));
      const rows = await currentDrizzleDb(db)
        .select({
          documentId: branchTreeChanges.nodeId,
          threadId: branchTreeChanges.createdThreadId,
        })
        .from(branchTreeChanges)
        .where(
          and(
            eq(branchTreeChanges.branchId, branchId),
            eq(branchTreeChanges.nodeKind, "document"),
            isNotNull(branchTreeChanges.createdThreadId),
            documentIds ? inArray(branchTreeChanges.nodeId, [...documentIds]) : undefined,
          ),
        );
      return new Map(
        rows.flatMap((row) =>
          row.threadId ? [[row.documentId as DocumentId, row.threadId as string] as const] : [],
        ),
      );
    },
    async listSettling(branchId) {
      const rows = await currentDrizzleDb(db)
        .select({ payload: branchPushSettlementPayloads.payload })
        .from(branchPushSettlementPayloads)
        .innerJoin(
          branchPushSettlementBatches,
          eq(branchPushSettlementBatches.id, branchPushSettlementPayloads.batchId),
        )
        .where(
          and(
            eq(branchPushSettlementPayloads.stepKind, BRANCH_TREE_STEP),
            eq(branchPushSettlementBatches.state, "pending"),
            sql`${branchPushSettlementPayloads.payload}->>'branchId' = ${branchId}`,
          ),
        );
      const keys = new Set<string>();
      for (const { payload } of rows) {
        const items = (payload as { items?: { itemKey?: string }[] }).items ?? [];
        for (const item of items) if (item.itemKey) keys.add(item.itemKey);
      }
      return keys;
    },
    async listBranchDraftEvidence(branchId, documentIds) {
      // One row per draft and writing chat: the journal is aggregated here, not shipped.
      const writer = sql<
        string | null
      >`case when ${draftWriteJournal.source} = 'agent' then ${draftWriteJournal.threadId} end`;
      const rows = await currentDrizzleDb(db)
        .select({
          draftId: documentDrafts.id,
          documentId: documentDrafts.documentId,
          generation: documentDrafts.generation,
          updatedAt: documentDrafts.updatedAt,
          hasEffect: documentDrafts.hasEffect,
          blocking: documentDrafts.blocking,
          writer,
          writes: sql<number>`count(${draftWriteJournal.id})::int`,
          lastWrite: sql<number | null>`max(${draftWriteJournal.id})`,
        })
        .from(documentDrafts)
        .leftJoin(
          draftWriteJournal,
          and(
            eq(draftWriteJournal.draftId, documentDrafts.id),
            eq(draftWriteJournal.generation, documentDrafts.generation),
            inArray(draftWriteJournal.status, ["active", "rollback_pending"]),
          ),
        )
        .where(
          and(
            eq(documentDrafts.branchId, branchId),
            eq(documentDrafts.kind, "work_draft"),
            eq(documentDrafts.status, "active"),
            documentIds ? inArray(documentDrafts.documentId, [...documentIds]) : undefined,
          ),
        )
        .groupBy(documentDrafts.id, writer)
        .orderBy(asc(documentDrafts.id), sql`max(${draftWriteJournal.id}) desc nulls last`);

      const evidence = new Map<string, WorkBranchPendingEvidence>();
      for (const row of rows) {
        const documentDraft = evidence.get(row.draftId) ?? {
          documentDraft: {
            draftId: row.draftId,
            documentId: row.documentId,
            branchId,
            generation: row.generation,
            updatedAt: row.updatedAt,
            hasEffect: row.hasEffect,
            blocking: row.blocking,
          },
          hasRows: false,
          agentThreadIds: [],
        };
        if (row.writes > 0) documentDraft.hasRows = true;
        if (row.writer) documentDraft.agentThreadIds.push(row.writer);
        evidence.set(row.draftId, documentDraft);
      }
      return [...evidence.values()];
    },
  };
}

async function commitPreparedDiscard(
  db: DrizzleDb,
  input: PreparedDiscardCommit,
  now: Date,
): Promise<void> {
  if (
    input.command &&
    !(await claimCommandWithinTx(db, input.command.envelope, input.command.result))
  ) {
    throw new BranchCommandExistsError(input.command.envelope.commandId);
  }
  await lockDocumentMutation(db, input.documentDraft.documentId);
  if (
    input.expectedLiveRevision !== undefined &&
    input.expectedLiveRevision !== (await readHeadRevision(db, input.documentDraft.documentId))
  )
    throw new DraftChangeRefusal("stale");

  // The re-forked (or row-discarded) draft is the new checkpoint, at the revision the
  // selection was made against; survivors re-journal under the row lock, inside it.
  const checkpoint = createCollabYDoc({ gc: false });
  let rewritten: Awaited<ReturnType<typeof commitRewriteWithinTx>>;
  try {
    Y.applyUpdate(checkpoint, input.state);
    rewritten = await commitRewriteWithinTx(db, {
      draftId: input.documentDraft.draftId,
      policy: { kind: "exact", revision: input.documentDraft.revision },
      fence: { kind: "none" },
      work: "active",
      doc: checkpoint,
      ...(input.survivors ? { reset: { kind: "refork" as const } } : {}),
      withinLock: input.survivors
        ? () => rejournalSurvivors(db, input, input.survivors ?? [])
        : undefined,
    });
  } finally {
    checkpoint.destroy();
  }
  if (rewritten.status !== "committed")
    throw new BranchPushCommitConflictError(input.documentDraft.draftId);

  const discardedRows = await db
    .update(draftWriteJournal)
    .set({
      status: "discarded",
      reviewedBy: input.reviewedByUserId ?? null,
      reviewedAt: now,
    })
    .where(
      and(
        eq(draftWriteJournal.draftId, input.documentDraft.draftId),
        eq(draftWriteJournal.generation, input.documentDraft.generation),
        inArray(draftWriteJournal.status, ["active", "rollback_pending"]),
        inArray(
          draftWriteJournal.id,
          input.journalRows.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: draftWriteJournal.id });
  if (discardedRows.length !== input.journalRows.length) {
    throw new BranchPushCommitConflictError(input.documentDraft.draftId);
  }
  await placeDraftRows(
    db,
    input.documentDraft.draftId,
    input.documentDraft.generation,
    input.journalRows.map((row) => row.id),
    { kind: "discarded" },
  );
  if (input.survivors) {
    await db
      .update(draftWriteJournal)
      .set({ status: "discarded" })
      .where(
        and(
          eq(draftWriteJournal.draftId, input.documentDraft.draftId),
          eq(draftWriteJournal.generation, input.documentDraft.generation),
          inArray(draftWriteJournal.status, ["active", "rollback_pending"]),
        ),
      );
  }
  await refreshDraftEffect(db, input.documentDraft.draftId);
  await bumpDraftRevisions(db, [input.documentDraft.draftId], { blocking: false });
}

/**
 * A selective Discard's surviving rows at the next generation (their content is in the
 * re-forked checkpoint), with their edit parts moved onto them; retired instead when the
 * item closes.
 */
async function rejournalSurvivors(
  db: DrizzleDb,
  input: PreparedDiscardCommit,
  survivors: NonNullable<PreparedDiscardCommit["survivors"]>,
): Promise<void> {
  for (const row of survivors) {
    if (input.retireSurvivors) {
      await placeDraftRows(db, row.draftId, input.documentDraft.generation, [row.id], {
        kind: "retired",
      });
      continue;
    }
    const [next] = await db
      .insert(draftWriteJournal)
      .values({
        draftId: row.draftId,
        generation: input.documentDraft.generation + 1,
        updateData: Buffer.from(row.updateData),
        source: row.source,
        actorUserId: row.actorUserId,
        threadId: row.threadId,
        turnId: row.turnId,
        wId: row.wId,
        toolCallId: row.toolCallId,
        updateMeta: row.updateMeta,
        status: row.status,
        draftBaseUpdateSeq: row.draftBaseUpdateSeq,
      })
      .returning({ id: draftWriteJournal.id });
    if (!next) throw new Error("Discard survivor was not journaled");
    await placeDraftRows(db, row.draftId, input.documentDraft.generation, [row.id], {
      kind: "pending",
      draftId: row.draftId,
      generation: input.documentDraft.generation + 1,
      rowId: next.id,
    });
  }
}

async function findLineage(db: DrizzleDb, idempotencyKey: string): Promise<PushLineageRow | null> {
  const [row] = await db
    .select()
    .from(pushLineage)
    .where(eq(pushLineage.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ? mapLineage(row) : null;
}

async function commitPreparedPush(
  db: DrizzleDb,
  input: PreparedPushCommit,
  now: Date,
): Promise<typeof pushLineage.$inferSelect> {
  await lockDocumentMutation(db, input.documentDraft.documentId);
  if (
    input.expectedLiveRevision !== undefined &&
    input.expectedLiveRevision !== (await readHeadRevision(db, input.documentDraft.documentId))
  )
    throw new DraftChangeRefusal("stale");

  // Staging flips the rows' status (a membership input): the revision fences and records it.
  // The revision alone fences the generation: a re-fork bumps it.
  const [casRow] = await bumpDraftRevisions(db, [input.documentDraft.draftId], {
    expectedRevision: input.documentDraft.revision,
  });
  if (!casRow) throw new BranchPushCommitConflictError(input.documentDraft.draftId);

  const [lineage] = await db
    .insert(pushLineage)
    .values({
      draftId: input.documentDraft.draftId,
      draftGeneration: input.documentDraft.generation,
      documentId: input.documentDraft.documentId,
      journalIds: input.journalRows.map((row) => row.id),
      upstreamUpdateSeq: null,
      pushedByUserId: input.pushedByUserId ?? null,
      threadId: representativeThreadId(input.journalRows),
      turnId: representativeTurnId(input.journalRows),
      idempotencyKey: input.idempotencyKey,
      receiptId: input.receiptId ?? randomUUID(),
    })
    .returning();
  if (!lineage) throw new Error("Failed to record push lineage");

  if (input.journalRows.length > 0) {
    const pushedRows = await db
      .update(draftWriteJournal)
      .set({
        status: "pushed",
        pushedAt: now,
        reviewedBy: input.pushedByUserId ?? null,
        reviewedAt: now,
      })
      .where(
        and(
          inArray(draftWriteJournal.status, ["active", "rollback_pending"]),
          inArray(
            draftWriteJournal.id,
            input.journalRows.map((row) => row.id),
          ),
        ),
      )
      .returning({ id: draftWriteJournal.id });
    if (pushedRows.length !== input.journalRows.length) {
      throw new BranchPushCommitConflictError(input.documentDraft.draftId);
    }
  }

  return lineage;
}

function representativeThreadId(rows: DraftJournalRow[]): ThreadId | null {
  const ids = new Set(rows.map((row) => row.threadId));
  const [id] = ids;
  return ids.size === 1 && id !== null ? id : null;
}

function representativeTurnId(rows: DraftJournalRow[]): TurnId | null {
  const ids = new Set(rows.map((row) => row.turnId));
  const [id] = ids;
  return ids.size === 1 && id !== null ? id : null;
}

function mapJournalRow(row: typeof draftWriteJournal.$inferSelect): DraftJournalRow {
  return {
    id: row.id,
    draftId: row.draftId,
    generation: row.generation,
    wId: row.wId,
    toolCallId: row.toolCallId,
    source: row.source,
    threadId: row.threadId,
    turnId: row.turnId,
    actorUserId: row.actorUserId,
    updateData: row.updateData,
    draftBaseUpdateSeq: row.draftBaseUpdateSeq,
    status: row.status,
    updateMeta: row.updateMeta,
  };
}

function mapLineage(row: typeof pushLineage.$inferSelect): PushLineageRow {
  return {
    id: row.id,
    draftId: row.draftId,
    draftGeneration: row.draftGeneration,
    documentId: row.documentId,
    journalIds: row.journalIds,
    upstreamUpdateSeq: row.upstreamUpdateSeq,
    idempotencyKey: row.idempotencyKey,
    receiptId: row.receiptId,
    threadId: row.threadId,
    turnId: row.turnId,
  };
}
