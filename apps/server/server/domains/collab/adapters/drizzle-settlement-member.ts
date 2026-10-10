/**
 * One push of a settlement batch, at the member boundary: staging its cut,
 * admitting it to the live journal with attribution, derivation and head, and
 * reconstructing its sweep evidence. Every function takes the caller's
 * transaction explicitly; the batch owner (`drizzle-pending-settlement.ts`)
 * holds the locks and orders the members.
 */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  branchPushOutboxUpdates,
  branchPushSettlementBatches,
  branchPushSettlementOutbox,
  branchWriteJournal,
  documentBranches,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
  pushLineage,
} from "@meridian/database/schema";
import {
  COLLAB_SCHEMA_VERSION,
  createCollabYDoc,
  packCollabSchemaVersion,
  unpackCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, asc, desc, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { NoticePort } from "../../notices/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { BranchSnapshot } from "../domain/branch-coordinator.js";
import type {
  BranchJournalRow,
  PendingLiveSettlement,
  PreparedPushCommit,
  PushLineageRow,
} from "../domain/branch-push-contracts.js";
import { activeBranchAgentWriteRows } from "../domain/branch-reversal-history.js";
import { deriveDocument } from "../domain/document-derivations.js";
import { parseDurableTrailSeedV1 } from "../domain/ports/change-trail-persistence.js";
import type { DocumentDerivationStore } from "../domain/ports/document-derivations.js";
import type { DocumentProjectionEffects } from "../domain/ports/document-projection-effects.js";
import type { DurableProjectionSerializer } from "../domain/ports/durable-projection.js";
import type {
  SettlementAdmission,
  SettlementCut,
} from "../domain/ports/pending-settlement-store.js";
import { journalInsertionRanges, ProvenanceMaterializationError } from "../domain/provenance.js";
import { materializeSweepEvidence } from "../domain/sweep-policy.js";
import { loadDocumentState } from "./document-loader.js";
import {
  allocateDocumentAdmission,
  ensureAndReadDocumentAuthorityHead,
} from "./drizzle-document-authority-head.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

/** A member row and its push, read once under the batch's locks. */
export type LockedSettlementMember = {
  outbox: typeof branchPushSettlementOutbox.$inferSelect;
  push: typeof pushLineage.$inferSelect;
};

export type MemberAdmissionDeps = {
  durableProjectionSerializer: DurableProjectionSerializer;
  projectionEffects: DocumentProjectionEffects;
  derivationStore: DocumentDerivationStore;
};

/** Every member of a batch with its push, in document order (the global lock order). */
export async function readSettlementMembers(
  db: DrizzleDb,
  batchId: string,
): Promise<LockedSettlementMember[]> {
  return db
    .select({ outbox: branchPushSettlementOutbox, push: pushLineage })
    .from(branchPushSettlementOutbox)
    .innerJoin(pushLineage, eq(pushLineage.id, branchPushSettlementOutbox.pushId))
    .where(eq(branchPushSettlementOutbox.batchId, batchId))
    .orderBy(asc(branchPushSettlementOutbox.documentId));
}

/** Stages one push: its cut, update and trail seed, and the durable reconcile since the cut. */
export async function stageSettlementMemberWithinTx(
  db: DrizzleDb,
  batchId: string,
  prepared: PreparedPushCommit,
  push: PushLineageRow,
): Promise<void> {
  const durablePrePush = await materializeDurableDocumentBefore(
    db,
    prepared.branch.documentId,
    push.upstreamUpdateSeq ?? Number.MAX_SAFE_INTEGER,
  );
  const cut = createCollabYDoc({ gc: false });
  Y.applyUpdate(cut, prepared.lockCutUpdate);
  const initialReconcile = Y.encodeStateAsUpdate(durablePrePush, Y.encodeStateVector(cut));
  const decodedReconcile = Y.decodeUpdate(initialReconcile);
  durablePrePush.destroy();
  cut.destroy();
  const reconciles = decodedReconcile.structs.length > 0 || decodedReconcile.ds.clients.size > 0;
  await db.insert(branchPushSettlementOutbox).values({
    pushId: push.id,
    batchId,
    documentId: push.documentId,
    documentTitle: prepared.documentTitle,
    lockCutUpdate: Buffer.from(prepared.lockCutUpdate),
    pushUpdate: Buffer.from(prepared.pushUpdate),
    trailSeed: parseDurableTrailSeedV1(prepared.trail),
    ...(reconciles ? { joinVersion: 1, classifiedJoinVersion: 1 } : {}),
  });
  if (reconciles) {
    await db.insert(branchPushOutboxUpdates).values({
      pushId: push.id,
      ordinal: 0,
      sourceKind: "initial_reconcile",
      sourceId: push.id,
      update: Buffer.from(initialReconcile),
    });
  }
}

/**
 * Puts pushes that never reached live back in review, inside the caller's
 * transaction: their journal rows are active again at their generation, their
 * unconsumed notices are retracted, and their lineage is deleted (the outbox
 * member and its joins cascade), so the idempotency key never answers "already
 * pushed" for an Apply that didn't happen. The caller retires their trail
 * contribution.
 */
export async function withdrawSettlementMembersWithinTx(
  db: DrizzleDb,
  pushes: readonly Pick<PushLineageRow, "id" | "journalIds">[],
  notices?: NoticePort,
): Promise<void> {
  if (pushes.length === 0) return;
  const journalIds = pushes.flatMap((push) => push.journalIds);
  if (journalIds.length > 0) {
    await db
      .update(branchWriteJournal)
      .set({ status: "active", pushedAt: null, reviewedBy: null, reviewedAt: null })
      .where(
        and(inArray(branchWriteJournal.id, journalIds), eq(branchWriteJournal.status, "pushed")),
      );
  }
  await notices?.retractForPushes(pushes.map((push) => String(push.id)));
  await db.delete(pushLineage).where(
    inArray(
      pushLineage.id,
      pushes.map((push) => push.id),
    ),
  );
}

/** Each member's lock cut and post-cut joins, read inside the completion transaction. */
export async function readSettlementCuts(
  db: DrizzleDb,
  members: readonly LockedSettlementMember[],
): Promise<SettlementCut[]> {
  const rows = members.map(({ outbox }) => outbox);
  const updates =
    rows.length > 0
      ? await db
          .select({
            pushId: branchPushOutboxUpdates.pushId,
            update: branchPushOutboxUpdates.update,
          })
          .from(branchPushOutboxUpdates)
          .where(
            inArray(
              branchPushOutboxUpdates.pushId,
              rows.map((row) => row.pushId),
            ),
          )
          .orderBy(branchPushOutboxUpdates.pushId, branchPushOutboxUpdates.ordinal)
      : [];
  return rows.map((row) => ({
    pushId: row.pushId,
    documentId: row.documentId as DocumentId,
    lockCutUpdate: row.lockCutUpdate,
    postCutUpdates: updates
      .filter(({ pushId }) => pushId === row.pushId)
      .map(({ update }) => update),
    pushUpdate: row.pushUpdate,
  }));
}

/**
 * Makes one locked member effective inside its batch's completion transaction:
 * the branch's authored rows and one reconcile row in the live journal, their
 * attribution, the certified derivation, the head, and joins into other batches.
 */
export async function admitSettlementMemberWithinTx(
  db: DrizzleDb,
  staged: LockedSettlementMember,
  deps: MemberAdmissionDeps,
): Promise<void> {
  const pushId = staged.push.id;
  const documentId = staged.outbox.documentId as DocumentId;

  const journalRows =
    staged.push.journalIds.length > 0
      ? (
          await db
            .select()
            .from(branchWriteJournal)
            .where(inArray(branchWriteJournal.id, staged.push.journalIds))
            .orderBy(branchWriteJournal.id)
        ).map(mapJournalRow)
      : [];
  const authority = await allocateDocumentAdmission(db, documentId);
  const authoredRows =
    journalRows.length > 0
      ? await db
          .insert(documentYjsUpdates)
          .values(
            journalRows.map((row, batchOrdinal) => ({
              documentId,
              authorityId: authority.authorityId,
              authorityGeneration: authority.generation,
              admissionSequence: authority.admissionSequence,
              batchOrdinal,
              updateData: Buffer.from(row.updateData),
              originType:
                row.source === "writer"
                  ? ("human" as const)
                  : row.turnId
                    ? ("agent" as const)
                    : ("system" as const),
              actorUserId: row.source === "writer" ? row.actorUserId : null,
              actorTurnId: row.source === "agent" ? row.turnId : null,
            })),
          )
          .returning({ id: documentYjsUpdates.id })
      : [];
  const [canonicalRow] = await db
    .insert(documentYjsUpdates)
    .values({
      documentId,
      authorityId: authority.authorityId,
      authorityGeneration: authority.generation,
      admissionSequence: authority.admissionSequence,
      batchOrdinal: journalRows.length,
      updateData: staged.outbox.pushUpdate,
      // Exact authored rows preserve attribution and reversal targets. This
      // aggregate system row resolves any omitted causal dependencies on replay.
      originType: "reconcile",
      actorUserId: null,
      actorTurnId: null,
    })
    .returning({ id: documentYjsUpdates.id });
  if (!canonicalRow) throw new Error(`Failed to complete staged push ${pushId}`);
  const [updated] = await db
    .update(pushLineage)
    .set({ upstreamUpdateSeq: canonicalRow.id })
    .where(and(eq(pushLineage.id, pushId), isNull(pushLineage.upstreamUpdateSeq)))
    .returning({ id: pushLineage.id });
  if (!updated) throw new Error(`Staged push ${pushId} was completed concurrently`);

  const [branchRow] = staged.push.branchId
    ? await db
        .select()
        .from(documentBranches)
        .where(eq(documentBranches.id, staged.push.branchId))
        .limit(1)
    : [];
  if (branchRow) {
    const branch: BranchSnapshot = {
      branchId: branchRow.id,
      documentId: branchRow.documentId,
      kind: branchRow.kind,
      upstreamBranchId: branchRow.upstreamBranchId,
      workId: branchRow.workId,
      threadId: branchRow.threadId,
      status: branchRow.status,
      generation: branchRow.generation,
      state: new Uint8Array(branchRow.state),
      stateVector: new Uint8Array(branchRow.stateVector),
      discardedStateVector: branchRow.discardedStateVector
        ? new Uint8Array(branchRow.discardedStateVector)
        : null,
      schemaVersion: unpackCollabSchemaVersion(branchRow.schemaVersion),
    };
    await writeMutationRows(db, branch, journalRows, authoredRows);
  }
  const derivation = await deriveDocument(
    {
      store: deps.derivationStore,
      serializer: deps.durableProjectionSerializer,
    },
    documentId,
  );
  // Completion already owns the mutation transaction: a stale cut is not an
  // expected scheduling deferral here and must not certify push completion.
  if (derivation.status !== "derived")
    throw new Error(`Uncertified durable document for push ${pushId}: ${derivation.status}`);
  const { stateVector } = derivation;
  await upsertHead(db, documentId, canonicalRow.id, stateVector);
  await deps.projectionEffects.applyPushCompletion({
    documentId,
    ...(branchRow?.workId ? { workId: branchRow.workId } : {}),
    at: new Date(),
  });

  await joinAdmissionWithinTx(db, {
    documentId,
    source: { kind: "staged_push", id: String(canonicalRow.id) },
    update: staged.outbox.pushUpdate,
    excludePushId: String(pushId),
  });
}

async function upsertHead(
  db: DrizzleDb,
  documentId: DocumentId,
  latestUpdateSeq: number,
  latestStateVector: Uint8Array,
): Promise<void> {
  const packedSchemaVersion = packCollabSchemaVersion(COLLAB_SCHEMA_VERSION);
  await db
    .insert(documentYjsHeads)
    .values({
      documentId,
      schemaVersion: packedSchemaVersion,
      latestUpdateSeq,
      latestStateVector: Buffer.from(latestStateVector),
      latestCheckpointId: null,
    })
    .onConflictDoUpdate({
      target: documentYjsHeads.documentId,
      set: {
        schemaVersion: sql`greatest(${documentYjsHeads.schemaVersion}, ${packedSchemaVersion})`,
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
  authoredRows: Array<{ id: number }>,
): Promise<void> {
  // Apply materializes only handles whose folded branch-reversal state remains
  // active; inactive handles must not reappear as live mutations.
  const mutationRows = activeBranchAgentWriteRows(rows);
  if (mutationRows.length === 0) return;
  await db
    .insert(agentEditMutations)
    .values(
      mutationRows.map((row) => {
        const rowIndex = rows.findIndex((candidate) => candidate.id === row.id);
        const updateSeq = rowIndex < 0 ? undefined : authoredRows[rowIndex]?.id;
        if (!updateSeq)
          throw new Error(`Missing live attribution for branch journal row ${row.id}`);
        return {
          wId: row.wId,
          documentId: branch.documentId,
          threadId: row.threadId,
          turnId: row.turnId,
          writeId: `push:${branch.branchId}:${row.id}`,
          status: "active" as const,
          createdSeq: updateSeq,
        };
      }),
    )
    .onConflictDoNothing();
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
    draftBaseUpdateSeq: row.draftBaseUpdateSeq,
    status: row.status,
    updateMeta: row.updateMeta,
  };
}

export function mapLineage(row: typeof pushLineage.$inferSelect): PushLineageRow {
  return {
    id: row.id,
    branchId: row.branchId,
    branchGeneration: row.branchGeneration,
    documentId: row.documentId,
    journalIds: row.journalIds,
    upstreamUpdateSeq: row.upstreamUpdateSeq,
    idempotencyKey: row.idempotencyKey,
    receiptId: row.receiptId,
    threadId: row.threadId,
    turnId: row.turnId,
  };
}

/** A member with its best-effort sweep evidence, for classification outside completion. */
export async function readSettlementMember(
  db: DrizzleDb,
  row: {
    outbox: typeof branchPushSettlementOutbox.$inferSelect;
    push: typeof pushLineage.$inferSelect;
  },
  eventSink?: EventSink,
): Promise<PendingLiveSettlement> {
  const pushId = row.outbox.pushId;
  const trail = parseDurableTrailSeedV1(row.outbox.trailSeed);
  const updates = await db
    .select({ update: branchPushOutboxUpdates.update })
    .from(branchPushOutboxUpdates)
    .where(eq(branchPushOutboxUpdates.pushId, pushId))
    .orderBy(branchPushOutboxUpdates.ordinal);
  let sweepEvidence: PendingLiveSettlement["sweepEvidence"] = null;
  try {
    const candidateRows =
      row.push.journalIds.length > 0
        ? await db
            .select({
              source: branchWriteJournal.source,
              draftBaseUpdateSeq: branchWriteJournal.draftBaseUpdateSeq,
              update: branchWriteJournal.updateData,
            })
            .from(branchWriteJournal)
            .where(inArray(branchWriteJournal.id, row.push.journalIds))
            .orderBy(branchWriteJournal.id)
        : [];
    const sweepCandidates = candidateRows.flatMap((candidate, index) =>
      candidate.source === "agent"
        ? [
            {
              precedingUpdates: candidateRows
                .slice(0, index)
                .map(({ update }) => new Uint8Array(update)),
              update: new Uint8Array(candidate.update),
              observedBaseUpdateSeq: candidate.draftBaseUpdateSeq,
            },
          ]
        : [],
    );
    if (sweepCandidates.length === 0) {
      throw new ProvenanceMaterializationError(
        `Pending branch push settlement ${pushId} has no agent observation watermark`,
      );
    }
    const authority = row.push.upstreamUpdateSeq
      ? (
          await db
            .select({
              authorityId: documentYjsUpdates.authorityId,
              generation: documentYjsUpdates.authorityGeneration,
            })
            .from(documentYjsUpdates)
            .where(eq(documentYjsUpdates.id, row.push.upstreamUpdateSeq))
            .limit(1)
        )[0]
      : await ensureAndReadDocumentAuthorityHead(db, row.outbox.documentId);
    if (!authority) {
      throw new ProvenanceMaterializationError(
        `Pending branch push settlement ${pushId} has no authority admission`,
      );
    }
    const latestObservationWatermark = sweepCandidates.reduce(
      (latest, { observedBaseUpdateSeq }) => Math.max(latest, observedBaseUpdateSeq),
      0,
    );
    const checkpointMetadata = await db
      .select({
        id: documentYjsCheckpoints.id,
        upToSeq: documentYjsCheckpoints.upToSeq,
      })
      .from(documentYjsCheckpoints)
      .where(
        and(
          eq(documentYjsCheckpoints.documentId, row.outbox.documentId),
          eq(documentYjsCheckpoints.authorityId, authority.authorityId),
          eq(documentYjsCheckpoints.authorityGeneration, authority.generation),
          lte(documentYjsCheckpoints.upToSeq, latestObservationWatermark),
        ),
      )
      .orderBy(desc(documentYjsCheckpoints.upToSeq), desc(documentYjsCheckpoints.id));
    const selectedCheckpoints = sweepCandidates.map((candidate) => {
      const checkpoint = checkpointMetadata.find(
        ({ upToSeq }) => upToSeq <= candidate.observedBaseUpdateSeq,
      );
      if (!checkpoint) {
        throw new ProvenanceMaterializationError(
          `Pending branch push settlement ${pushId} has no neutral root floor`,
        );
      }
      return { candidate, checkpointId: checkpoint.id };
    });
    const checkpointIds = [...new Set(selectedCheckpoints.map(({ checkpointId }) => checkpointId))];
    const checkpointStates = await db
      .select({
        id: documentYjsCheckpoints.id,
        state: documentYjsCheckpoints.state,
      })
      .from(documentYjsCheckpoints)
      .where(inArray(documentYjsCheckpoints.id, checkpointIds));
    const rootsByCheckpoint = new Map(
      checkpointStates.map(({ id, state }) => [id, journalInsertionRanges(new Uint8Array(state))]),
    );
    const attributedRows = await db
      .select({
        journalRowId: documentYjsUpdates.id,
        originType: documentYjsUpdates.originType,
        actorUserId: documentYjsUpdates.actorUserId,
        update: documentYjsUpdates.updateData,
      })
      .from(documentYjsUpdates)
      .where(
        and(
          eq(documentYjsUpdates.documentId, row.outbox.documentId),
          eq(documentYjsUpdates.authorityId, authority.authorityId),
          eq(documentYjsUpdates.authorityGeneration, authority.generation),
        ),
      )
      .orderBy(
        documentYjsUpdates.admissionSequence,
        documentYjsUpdates.batchOrdinal,
        documentYjsUpdates.id,
      );
    sweepEvidence = materializeSweepEvidence({
      candidates: selectedCheckpoints.map(({ candidate, checkpointId }) => {
        const roots = rootsByCheckpoint.get(checkpointId);
        if (!roots) {
          throw new ProvenanceMaterializationError(
            `Pending branch push settlement ${pushId} lost its neutral root floor`,
          );
        }
        return {
          ...candidate,
          rootFloor: { key: String(checkpointId), roots },
        };
      }),
      rows: attributedRows.map((attribution) => ({
        ...attribution,
        journalRowId: BigInt(attribution.journalRowId),
        update: new Uint8Array(attribution.update),
      })),
    });
  } catch (cause) {
    if (!(cause instanceof ProvenanceMaterializationError)) throw cause;
    if (eventSink) {
      emitEvent(eventSink, {
        level: "warn",
        source: "collab.change_event",
        name: "sweep_projection.unavailable",
        payload: {
          pushId,
          documentId: row.outbox.documentId,
          ...unknownToEventPayload(cause),
        },
      });
    }
  }
  return {
    push: mapLineage(row.push),
    documentTitle: row.outbox.documentTitle,
    lockCutUpdate: row.outbox.lockCutUpdate,
    pushUpdate: row.outbox.pushUpdate,
    postCutUpdates: updates.map(({ update }) => update),
    trail,
    sweepEvidence,
    joinVersion: row.outbox.joinVersion,
  };
}

export async function joinAdmissionWithinTx(
  db: Pick<Database, "select" | "insert" | "update">,
  input: SettlementAdmission,
): Promise<number> {
  const sourceId = Number(input.source.id);
  if (!Number.isSafeInteger(sourceId)) {
    throw new Error(`Settlement admission source id is not a safe integer: ${input.source.id}`);
  }
  const excludePushId = input.excludePushId === undefined ? undefined : Number(input.excludePushId);
  if (excludePushId !== undefined && !Number.isSafeInteger(excludePushId)) {
    throw new Error(`Excluded settlement push id is not a safe integer: ${input.excludePushId}`);
  }
  const targets = await db
    .select({
      pushId: branchPushSettlementOutbox.pushId,
      ordinal: branchPushSettlementOutbox.joinVersion,
    })
    .from(branchPushSettlementOutbox)
    .innerJoin(
      branchPushSettlementBatches,
      eq(branchPushSettlementBatches.id, branchPushSettlementOutbox.batchId),
    )
    .where(
      and(
        eq(branchPushSettlementOutbox.documentId, input.documentId),
        inArray(branchPushSettlementBatches.state, ["pending", "blocked"]),
        excludePushId === undefined
          ? undefined
          : ne(branchPushSettlementOutbox.pushId, excludePushId),
      ),
    );
  let joined = 0;
  for (const target of targets) {
    const inserted = await db
      .insert(branchPushOutboxUpdates)
      .values({
        pushId: target.pushId,
        ordinal: target.ordinal,
        sourceKind: input.source.kind,
        sourceId,
        update: Buffer.from(input.update),
      })
      .onConflictDoNothing()
      .returning({ pushId: branchPushOutboxUpdates.pushId });
    if (inserted.length === 0) continue;
    await db
      .update(branchPushSettlementOutbox)
      .set({
        joinVersion: sql`${branchPushSettlementOutbox.joinVersion} + 1`,
        // App-clock → DB-clock convergence for journal admissions is deliberate (2026-07-24 divergence decision).
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(branchPushSettlementOutbox.pushId, target.pushId));
    joined += 1;
  }
  return joined;
}

async function materializeDurableDocumentBefore(
  db: DrizzleDb,
  documentId: DocumentId,
  beforeUpdateSeq: number,
): Promise<Y.Doc> {
  const journal = createDrizzleJournal(db as Database);
  // Journal bounds are inclusive; settlement must exclude its own push update.
  const snapshot = await journal.read(documentId, { until: beforeUpdateSeq - 1 });
  const state = await loadDocumentState(journal, documentId, undefined, snapshot);
  const doc = createCollabYDoc({ gc: false });
  if (state) Y.applyUpdate(doc, state);
  return doc;
}
