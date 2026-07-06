/** Drizzle store for durable branch pushes into the live Yjs journal. */
import { randomUUID } from "node:crypto";
import { toDocHandle, type YProsemirrorDocumentModel } from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  branchWriteJournal,
  contextSources,
  documentBranches,
  documents,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
  projects,
  pushLineage,
  threadDocuments,
  works,
} from "@meridian/database/schema";
import type { MarkupCodec } from "@meridian/markup";
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { BranchSnapshot } from "../domain/branch-coordinator.js";
import type {
  BranchJournalRow,
  BranchPushStore,
  PreparedPushCommit,
  PushLineageRow,
} from "../domain/branch-push.js";
import { BranchPushCommitConflictError } from "../domain/branch-push.js";
import { LIVE_SCOPE, scopedValues } from "./drizzle-agent-edit-scope.js";

export function createDrizzleBranchPushStore(
  db: Database,
  projection?: { model: YProsemirrorDocumentModel; codec: MarkupCodec },
): BranchPushStore {
  return {
    async listActiveJournalRows(branchId, generation) {
      const rows = await db
        .select()
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.branchId, branchId),
            eq(branchWriteJournal.generation, generation),
            eq(branchWriteJournal.status, "active"),
          ),
        )
        .orderBy(branchWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async listConcurrentJournalRows(branchId, generation) {
      const rows = await db
        .select()
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.branchId, branchId),
            sql`${branchWriteJournal.generation} <= ${generation}`,
            sql`${branchWriteJournal.status} IN ('active', 'pushed')`,
          ),
        )
        .orderBy(branchWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async latestPushForBranch(branchId, generation) {
      const [row] = await db
        .select()
        .from(pushLineage)
        .where(
          and(
            eq(pushLineage.branchId, branchId),
            sql`${pushLineage.receiptPayload}->>'branchGeneration' = ${String(generation)}`,
          ),
        )
        .orderBy(sql`${pushLineage.id} DESC`)
        .limit(1);
      return row ? mapLineage(row) : null;
    },

    async listPushesForDocument(documentId) {
      const rows = await db
        .select()
        .from(pushLineage)
        .where(eq(pushLineage.documentId, documentId))
        .orderBy(desc(pushLineage.id));
      return rows.map(mapLineage);
    },

    async commitPush(input) {
      return runInDrizzleTransaction(db, async () => {
        const txDb = currentDrizzleDb(db);
        const existing = await findLineage(txDb, input.idempotencyKey);
        if (existing) return { status: "conflict" as const, push: existing };
        const now = new Date();
        const lineage = await commitPreparedPush(txDb, input, now, projection);
        return { status: "inserted" as const, push: mapLineage(lineage) };
      });
    },

    async commitPushBatch(input) {
      return runInDrizzleTransaction(db, async () => {
        const txDb = currentDrizzleDb(db);
        for (const push of input.pushes) {
          const existing = await findLineage(txDb, push.idempotencyKey);
          if (existing) throw new BranchPushCommitConflictError(push.branch.branchId);
        }
        const now = new Date();
        const rows = [];
        for (const push of input.pushes) {
          rows.push(await commitPreparedPush(txDb, push, now, projection));
        }
        return { pushes: rows.map(mapLineage) };
      });
    },

    async countUnpushedRowsForWork(workId) {
      const [{ count } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(branchWriteJournal)
        .innerJoin(documentBranches, eq(branchWriteJournal.branchId, documentBranches.id))
        .where(
          and(
            eq(documentBranches.workId, workId),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
            eq(branchWriteJournal.generation, documentBranches.generation),
            eq(branchWriteJournal.status, "active"),
          ),
        );
      return count;
    },

    async listActiveWorkDraftBranchIdsForWork(workId) {
      const rows = await db
        .select({ id: documentBranches.id })
        .from(documentBranches)
        .where(
          and(
            eq(documentBranches.workId, workId),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
          ),
        );
      return rows.map((row) => row.id);
    },

    async updateWorkDraftPushPolicy(workId, policy) {
      await runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db)
          .update(documentBranches)
          .set({ pushPolicy: policy, updatedAt: new Date() })
          .where(
            and(
              eq(documentBranches.workId, workId),
              eq(documentBranches.kind, "work_draft"),
              eq(documentBranches.status, "active"),
            ),
          );
        await currentDrizzleDb(db)
          .update(works)
          .set({ aiWriteMode: aiWriteModeProjection(policy), updatedAt: new Date() })
          .where(eq(works.id, workId));
      });
    },

    async markRollbackPending(input) {
      const rows = await db
        .update(branchWriteJournal)
        .set({ status: "rollback_pending" })
        .where(
          and(
            eq(branchWriteJournal.branchId, input.branchId),
            eq(branchWriteJournal.threadId, input.threadId),
            eq(branchWriteJournal.turnId, input.turnId),
            eq(branchWriteJournal.status, "active"),
          ),
        )
        .returning({ id: branchWriteJournal.id });
      return rows.length;
    },
  };
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
  projection?: { model: YProsemirrorDocumentModel; codec: MarkupCodec },
): Promise<typeof pushLineage.$inferSelect> {
  const [casRow] = await db
    .update(documentBranches)
    .set({ updatedAt: sql`${documentBranches.updatedAt}` })
    .where(
      and(
        eq(documentBranches.id, input.branch.branchId),
        eq(documentBranches.status, "active"),
        eq(documentBranches.generation, input.branch.generation),
        eq(documentBranches.state, Buffer.from(input.branch.state)),
      ),
    )
    .returning({ id: documentBranches.id });
  if (!casRow) throw new BranchPushCommitConflictError(input.branch.branchId);

  const [updateRow] = await db
    .insert(documentYjsUpdates)
    .values({
      documentId: input.branch.documentId,
      updateData: Buffer.from(input.pushUpdate),
      originType: "system",
    })
    .returning({ id: documentYjsUpdates.id });
  if (!updateRow) throw new Error("Failed to append push update");

  const durableProjection = projection
    ? await deriveDurableProjection(db, input.branch.documentId, projection)
    : { markdownProjection: input.markdownProjection, stateVector: input.liveStateVector };
  await upsertHead(db, input.branch.documentId, updateRow.id, durableProjection.stateVector);
  await writeMutationRows(db, input.branch, input.journalRows, updateRow.id);
  await refreshProjectionAndActivity(db, input.branch, durableProjection.markdownProjection, now);

  const [lineage] = await db
    .insert(pushLineage)
    .values({
      branchId: input.branch.branchId,
      documentId: input.branch.documentId,
      pushKind: input.receiptPayload.pushKind,
      journalIds: input.journalRows.map((row) => row.id),
      upstreamUpdateSeq: updateRow.id,
      receiptPayload: input.receiptPayload,
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
      .update(branchWriteJournal)
      .set({ status: "pushed", pushedAt: now })
      .where(
        and(
          eq(branchWriteJournal.status, "active"),
          inArray(
            branchWriteJournal.id,
            input.journalRows.map((row) => row.id),
          ),
        ),
      )
      .returning({ id: branchWriteJournal.id });
    if (pushedRows.length !== input.journalRows.length) {
      throw new BranchPushCommitConflictError(input.branch.branchId);
    }
  }

  return lineage;
}

async function upsertHead(
  db: DrizzleDb,
  documentId: DocumentId,
  latestUpdateSeq: number,
  latestStateVector: Uint8Array,
): Promise<void> {
  await db
    .insert(documentYjsHeads)
    .values({
      documentId,
      schemaVersion: COLLAB_SCHEMA_VERSION,
      latestUpdateSeq,
      latestStateVector: Buffer.from(latestStateVector),
      latestCheckpointId: null,
    })
    .onConflictDoUpdate({
      target: documentYjsHeads.documentId,
      set: {
        schemaVersion: sql`greatest(${documentYjsHeads.schemaVersion}, ${COLLAB_SCHEMA_VERSION})`,
        latestUpdateSeq,
        latestStateVector: Buffer.from(latestStateVector),
        updatedAt: sql`now()`,
      },
    });
}

async function writeMutationRows(
  db: DrizzleDb,
  branch: BranchSnapshot,
  rows: BranchJournalRow[],
  updateSeq: number,
): Promise<void> {
  const mutationRows = rows.filter(
    (row): row is BranchJournalRow & { threadId: ThreadId; wId: number } =>
      row.threadId !== null && row.wId !== null,
  );
  if (mutationRows.length === 0) return;
  await db
    .insert(agentEditMutations)
    .values(
      mutationRows.map((row) => ({
        wId: row.wId,
        ...scopedValues({
          documentId: branch.documentId,
          threadId: row.threadId,
          scopeId: LIVE_SCOPE,
        }),
        turnId: row.turnId,
        writeId: `push:${branch.branchId}:${row.id}`,
        status: "active" as const,
        createdSeq: updateSeq,
      })),
    )
    .onConflictDoNothing();
}

async function refreshProjectionAndActivity(
  db: DrizzleDb,
  branch: BranchSnapshot,
  markdownProjection: string,
  now: Date,
): Promise<void> {
  await db
    .update(documents)
    .set({ markdownProjection, updatedAt: now })
    .where(eq(documents.id, branch.documentId));
  await db
    .update(threadDocuments)
    .set({ lastTouchedAt: now })
    .where(eq(threadDocuments.documentId, branch.documentId));
  if (branch.workId)
    await db.update(works).set({ updatedAt: now }).where(eq(works.id, branch.workId));
  const [scope] = await db
    .select({ projectId: contextSources.projectId })
    .from(documents)
    .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
    .where(and(eq(documents.id, branch.documentId), isNull(documents.deletedAt)))
    .limit(1);
  if (scope?.projectId) {
    await db
      .update(projects)
      .set({ updatedAt: now, lastActivityAt: now })
      .where(eq(projects.id, scope.projectId));
  }
}

function representativeThreadId(rows: BranchJournalRow[]): ThreadId | null {
  const ids = new Set(rows.map((row) => row.threadId).filter((id): id is ThreadId => id !== null));
  return ids.size === 1 ? [...ids][0] : null;
}

function representativeTurnId(rows: BranchJournalRow[]): TurnId | null {
  const ids = new Set(rows.map((row) => row.turnId).filter((id): id is TurnId => id !== null));
  return ids.size === 1 ? [...ids][0] : null;
}

function mapJournalRow(row: typeof branchWriteJournal.$inferSelect): BranchJournalRow {
  return {
    id: row.id,
    branchId: row.branchId,
    generation: row.generation,
    wId: row.wId,
    source: row.source,
    threadId: row.threadId,
    turnId: row.turnId,
    actorUserId: row.actorUserId,
    updateData: row.updateData,
    status: row.status,
    updateMeta: row.updateMeta,
  };
}

function mapLineage(row: typeof pushLineage.$inferSelect): PushLineageRow {
  return {
    id: row.id,
    branchId: row.branchId,
    documentId: row.documentId,
    pushKind: row.pushKind,
    journalIds: row.journalIds,
    upstreamUpdateSeq: row.upstreamUpdateSeq,
    receiptPayload: row.receiptPayload as PushLineageRow["receiptPayload"],
    idempotencyKey: row.idempotencyKey,
    receiptId: row.receiptId,
    threadId: row.threadId,
    turnId: row.turnId,
  };
}

async function deriveDurableProjection(
  db: DrizzleDb,
  documentId: DocumentId,
  projection: { model: YProsemirrorDocumentModel; codec: MarkupCodec },
): Promise<{ markdownProjection: string; stateVector: Uint8Array }> {
  await lockDocumentYjsHead(db, documentId);
  const [{ minRetainedSeq } = { minRetainedSeq: null }] = await db
    .select({ minRetainedSeq: sql<number | null>`min(${documentYjsUpdates.id})` })
    .from(documentYjsUpdates)
    .where(eq(documentYjsUpdates.documentId, documentId));
  const checkpoint = minRetainedSeq
    ? (
        await db
          .select()
          .from(documentYjsCheckpoints)
          .where(
            and(
              eq(documentYjsCheckpoints.documentId, documentId),
              lt(documentYjsCheckpoints.upToSeq, minRetainedSeq),
            ),
          )
          .orderBy(desc(documentYjsCheckpoints.upToSeq), desc(documentYjsCheckpoints.id))
          .limit(1)
      )[0]
    : null;
  const rows = await db
    .select({ updateData: documentYjsUpdates.updateData })
    .from(documentYjsUpdates)
    .where(eq(documentYjsUpdates.documentId, documentId))
    .orderBy(documentYjsUpdates.id);
  const doc = createCollabYDoc({ gc: false });
  if (checkpoint) Y.applyUpdate(doc, checkpoint.state);
  for (const row of rows) Y.applyUpdate(doc, row.updateData);
  const blocks = projection.model.getBlocks(toDocHandle(doc));
  return {
    markdownProjection:
      blocks.length === 0
        ? ""
        : projection.codec.serialize(projection.model.projectBlocks(toDocHandle(doc))),
    stateVector: Y.encodeStateVector(doc),
  };
}

async function lockDocumentYjsHead(db: DrizzleDb, documentId: DocumentId): Promise<void> {
  await db
    .insert(documentYjsHeads)
    .values({
      documentId,
      schemaVersion: COLLAB_SCHEMA_VERSION,
      latestUpdateSeq: 0,
      latestStateVector: Buffer.from(new Uint8Array()),
      latestCheckpointId: null,
    })
    .onConflictDoNothing({ target: documentYjsHeads.documentId });
  await db.execute(
    sql`SELECT document_id FROM document_yjs_heads WHERE document_id = ${documentId} FOR UPDATE`,
  );
}

function aiWriteModeProjection(policy: "manual" | "auto"): "draft" | "direct" {
  return policy === "manual" ? "draft" : "direct";
}
