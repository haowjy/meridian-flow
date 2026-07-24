/** Drizzle persistence authority for pending branch-push settlement. */
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  branchPushOutboxUpdates,
  branchPushSettlementOutbox,
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
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { NoticePort } from "../../notices/index.js";
import type { BranchSnapshot } from "../domain/branch-coordinator.js";
import type {
  BranchJournalRow,
  PendingLiveSettlement,
  PreparedPushCommit,
  PushLineageRow,
  SettlementClaim,
} from "../domain/branch-push-contracts.js";
import { activeBranchAgentWriteRows } from "../domain/branch-reversal-history.js";
import type { ChangeTrailPersistence } from "../domain/ports/change-trail-persistence.js";
import { parseDurableTrailSeedV1 } from "../domain/ports/change-trail-persistence.js";
import type { DurableProjectionSerializer } from "../domain/ports/durable-projection.js";
import type {
  PendingSettlementStore,
  SettlementAdmission,
} from "../domain/ports/pending-settlement-store.js";
import { materializeProvenanceForDoc } from "../domain/provenance.js";
import {
  allocateDocumentAdmission,
  readDocumentAuthorityHead,
} from "./drizzle-document-authority-head.js";
import { lockDocumentMutation } from "./drizzle-document-mutation-lock.js";
import { createDrizzleProvenanceReader } from "./drizzle-provenance.js";

export async function stagePendingSettlementWithinTx(
  db: DrizzleDb,
  prepared: PreparedPushCommit,
  push: PushLineageRow,
): Promise<void> {
  const durablePrePush = await materializeDurableDocumentBefore(
    db,
    prepared.branch.documentId,
    push.upstreamUpdateSeq ?? Number.MAX_SAFE_INTEGER,
  );
  const cut = createCollabYDoc({ gc: false });
  Y.applyUpdate(cut, prepared.pendingLiveSettlement.lockCutUpdate);
  const initialReconcile = Y.encodeStateAsUpdate(durablePrePush, Y.encodeStateVector(cut));
  const decodedReconcile = Y.decodeUpdate(initialReconcile);
  durablePrePush.destroy();
  cut.destroy();
  const trailSeed = parseDurableTrailSeedV1(prepared.pendingLiveSettlement.trail);
  const lease = await databaseLease(db);
  await db.insert(branchPushSettlementOutbox).values({
    pushId: push.id,
    documentId: push.documentId,
    documentTitle: prepared.pendingLiveSettlement.documentTitle,
    lockCutUpdate: Buffer.from(prepared.pendingLiveSettlement.lockCutUpdate),
    pushUpdate: Buffer.from(prepared.pendingLiveSettlement.pushUpdate),
    beforeContentRef: prepared.pendingLiveSettlement.beforeContentRef,
    trailSeed,
    claimToken: prepared.pendingLiveSettlement.claim.token,
    claimEpoch: 1,
    claimKind: "warm",
    claimedAt: lease.now,
    leaseExpiresAt: lease.expiresAt,
    availableAt: lease.now,
  });
  if (decodedReconcile.structs.length > 0 || decodedReconcile.ds.clients.size > 0) {
    await db.insert(branchPushOutboxUpdates).values({
      pushId: push.id,
      ordinal: 0,
      sourceKind: "initial_reconcile",
      sourceId: push.id,
      update: Buffer.from(initialReconcile),
    });
    await db
      .update(branchPushSettlementOutbox)
      .set({ joinVersion: 1, classifiedJoinVersion: 1 })
      .where(eq(branchPushSettlementOutbox.pushId, push.id));
  }
}

export type StagePendingSettlementWithinTx = typeof stagePendingSettlementWithinTx;

export function createDrizzlePendingSettlementStore(
  db: Database,
  durableProjectionSerializer: DurableProjectionSerializer,
  changeTrails: ChangeTrailPersistence,
  notices?: NoticePort,
): PendingSettlementStore {
  return {
    async joinAdmission(input) {
      await runInDrizzleTransaction(db, async () => {
        await joinAdmissionWithinTx(currentDrizzleDb(db), input);
      });
    },
    async settlePushTrail(input) {
      return runInDrizzleTransaction(db, async () => {
        const txDb = currentDrizzleDb(db);
        await lockDocumentMutation(txDb, input.push.documentId);
        const [owned] = await txDb
          .select({
            pushId: branchPushSettlementOutbox.pushId,
            classifiedJoinVersion: branchPushSettlementOutbox.classifiedJoinVersion,
          })
          .from(branchPushSettlementOutbox)
          .where(ownerPredicate(input.push.id, input.claim, input.joinVersion))
          .for("update")
          .limit(1);
        if (!owned) return false;
        if (input.replacement) {
          await changeTrails.replacePushContribution(String(input.push.id), input.replacement, {
            refineCurrentVersion: owned.classifiedJoinVersion === input.joinVersion,
          });
        }
        if (input.trail?.transactionalNotice && owned.classifiedJoinVersion !== input.joinVersion) {
          await notices?.record({
            ...input.trail.transactionalNotice,
            data: {
              ...input.trail.transactionalNotice.data,
              pushId: String(input.push.id),
              threadId: input.push.threadId ?? null,
              turnId: input.push.turnId ?? null,
            },
          });
        }
        const [settled] = await txDb
          .update(branchPushSettlementOutbox)
          .set({
            classifiedJoinVersion: input.joinVersion,
            settledJoinVersion: input.joinVersion,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(ownerPredicate(input.push.id, input.claim, input.joinVersion))
          .returning({ pushId: branchPushSettlementOutbox.pushId });
        return Boolean(settled);
      });
    },

    async listRecoverableSettlementIds() {
      const rows = await db
        .select({ pushId: branchPushSettlementOutbox.pushId })
        .from(branchPushSettlementOutbox)
        .where(
          and(
            eq(branchPushSettlementOutbox.state, "pending"),
            sql`${branchPushSettlementOutbox.availableAt} <= clock_timestamp()`,
            or(
              isNull(branchPushSettlementOutbox.claimToken),
              sql`${branchPushSettlementOutbox.leaseExpiresAt} <= clock_timestamp()`,
            ),
          ),
        )
        .orderBy(branchPushSettlementOutbox.createdAt);
      return rows.map((row) => row.pushId);
    },

    async loadLiveSettlement(pushId) {
      return readPendingSettlement(db, pushId);
    },

    async withCompletionFence(input, complete) {
      class CompletionRetry extends Error {}
      try {
        return await runInDrizzleTransaction(db, async () => {
          const txDb = currentDrizzleDb(db);
          await lockDocumentMutation(txDb, input.documentId);
          const [owned] = await txDb
            .select({ pushId: branchPushSettlementOutbox.pushId })
            .from(branchPushSettlementOutbox)
            .where(
              and(
                ownerPredicate(input.pushId, input.claim, input.settledJoinVersion),
                eq(branchPushSettlementOutbox.settledJoinVersion, input.settledJoinVersion),
              ),
            )
            .for("update")
            .limit(1);
          if (!owned) throw new CompletionRetry();

          // Persist the staged candidate before the synchronous live apply. If the
          // recheck rejects it, throwing rolls this entire admission back.
          await completeStagedPush(
            txDb,
            input.pushId,
            input.documentId,
            durableProjectionSerializer,
          );
          const result = complete();
          if (result !== "applied" && result !== "already_applied" && result !== "retry") {
            throw new Error("Completion fence callback must return synchronously");
          }
          if (result === "retry") throw new CompletionRetry();
          const [completed] = await txDb
            .update(branchPushSettlementOutbox)
            .set({
              state: "completed",
              completedAt: sql`clock_timestamp()`,
              claimToken: null,
              claimKind: null,
              claimedAt: null,
              leaseExpiresAt: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                ownerPredicate(input.pushId, input.claim, input.settledJoinVersion),
                eq(branchPushSettlementOutbox.settledJoinVersion, input.settledJoinVersion),
              ),
            )
            .returning({ pushId: branchPushSettlementOutbox.pushId });
          if (!completed) throw new CompletionRetry();
          return result;
        });
      } catch (cause) {
        if (cause instanceof CompletionRetry) return "retry" as const;
        throw cause;
      }
    },

    async renewClaim(input) {
      const lease = await databaseLease(db);
      const [renewed] = await db
        .update(branchPushSettlementOutbox)
        .set({ leaseExpiresAt: lease.expiresAt, updatedAt: lease.now })
        .where(ownerPredicate(input.pushId, input.claim))
        .returning({ leaseExpiresAt: branchPushSettlementOutbox.leaseExpiresAt });
      return renewed?.leaseExpiresAt
        ? { ...input.claim, leaseExpiresAt: renewed.leaseExpiresAt }
        : null;
    },

    async handoffClaim(input) {
      const [released] = await db
        .update(branchPushSettlementOutbox)
        .set({
          claimToken: null,
          claimKind: null,
          claimedAt: null,
          leaseExpiresAt: null,
          availableAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(ownerPredicate(input.pushId, input.claim))
        .returning({ pushId: branchPushSettlementOutbox.pushId });
      return Boolean(released);
    },

    async claimRecoverable(input) {
      const claimed = await runInDrizzleTransaction(db, async () => {
        const txDb = currentDrizzleDb(db);
        const [candidate] = await txDb
          .select({ documentId: branchPushSettlementOutbox.documentId })
          .from(branchPushSettlementOutbox)
          .where(eq(branchPushSettlementOutbox.pushId, input.pushId))
          .for("update")
          .limit(1);
        if (!candidate) return null;
        await lockDocumentMutation(txDb, candidate.documentId);
        const lease = await databaseLease(txDb);
        const [row] = await txDb
          .update(branchPushSettlementOutbox)
          .set({
            claimToken: input.token,
            claimEpoch: sql`${branchPushSettlementOutbox.claimEpoch} + 1`,
            claimKind: "recovery",
            claimedAt: lease.now,
            leaseExpiresAt: lease.expiresAt,
            updatedAt: lease.now,
          })
          .where(
            and(
              eq(branchPushSettlementOutbox.pushId, input.pushId),
              eq(branchPushSettlementOutbox.state, "pending"),
              lte(branchPushSettlementOutbox.availableAt, lease.now),
              or(
                isNull(branchPushSettlementOutbox.claimToken),
                lte(branchPushSettlementOutbox.leaseExpiresAt, lease.now),
              ),
            ),
          )
          .returning({
            epoch: branchPushSettlementOutbox.claimEpoch,
            leaseExpiresAt: branchPushSettlementOutbox.leaseExpiresAt,
          });
        return row?.leaseExpiresAt
          ? ({
              token: input.token,
              epoch: row.epoch,
              kind: "recovery",
              leaseExpiresAt: row.leaseExpiresAt,
            } satisfies SettlementClaim)
          : null;
      });
      if (!claimed) return null;
      try {
        return await readPendingSettlement(db, input.pushId);
      } catch (cause) {
        await db
          .update(branchPushSettlementOutbox)
          .set({
            state: "blocked",
            lastErrorCode: "corrupt_settlement_authority",
            lastError: cause instanceof Error ? cause.message : String(cause),
            blockedAt: sql`clock_timestamp()`,
            claimToken: null,
            claimKind: null,
            claimedAt: null,
            leaseExpiresAt: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(ownerPredicate(input.pushId, claimed));
        throw cause;
      }
    },

    async recordFailure(failure) {
      const [failed] = await db
        .update(branchPushSettlementOutbox)
        .set({
          state: "pending",
          attemptCount: sql`${branchPushSettlementOutbox.attemptCount} + 1`,
          lastError: failure.error,
          availableAt: sql`clock_timestamp() + make_interval(secs => least(60, power(2, least(6, ${branchPushSettlementOutbox.attemptCount} + 1))::int))`,
          claimToken: null,
          claimKind: null,
          claimedAt: null,
          leaseExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(ownerPredicate(failure.pushId, failure.claim))
        .returning({ pushId: branchPushSettlementOutbox.pushId });
      return Boolean(failed);
    },

    async block(failure) {
      const [blocked] = await db
        .update(branchPushSettlementOutbox)
        .set({
          state: "blocked",
          lastErrorCode: failure.code,
          lastError: failure.error,
          blockedAt: sql`clock_timestamp()`,
          claimToken: null,
          claimKind: null,
          claimedAt: null,
          leaseExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(ownerPredicate(failure.pushId, failure.claim))
        .returning({ pushId: branchPushSettlementOutbox.pushId });
      return Boolean(blocked);
    },
  };
}

/** Makes one staged candidate effective inside the completion-fence transaction. */
async function completeStagedPush(
  db: DrizzleDb,
  pushId: number,
  documentId: DocumentId,
  durableProjectionSerializer: DurableProjectionSerializer,
): Promise<void> {
  const [staged] = await db
    .select({ outbox: branchPushSettlementOutbox, push: pushLineage })
    .from(branchPushSettlementOutbox)
    .innerJoin(pushLineage, eq(pushLineage.id, branchPushSettlementOutbox.pushId))
    .where(
      and(
        eq(branchPushSettlementOutbox.pushId, pushId),
        eq(branchPushSettlementOutbox.documentId, documentId),
      ),
    )
    .limit(1);
  if (!staged) throw new Error(`Staged push ${pushId} is unavailable`);
  if (staged.push.upstreamUpdateSeq !== null) {
    await joinAdmissionWithinTx(db, {
      documentId,
      source: { kind: "staged_push", id: String(staged.push.upstreamUpdateSeq) },
      update: staged.outbox.pushUpdate,
      excludePushId: String(pushId),
    });
    return;
  }

  const authority = await allocateDocumentAdmission(db, documentId);
  const [updateRow] = await db
    .insert(documentYjsUpdates)
    .values({
      documentId,
      authorityId: authority.authorityId,
      authorityGeneration: authority.generation,
      admissionSequence: authority.admissionSequence,
      batchOrdinal: 0,
      updateData: staged.outbox.pushUpdate,
      // A writer-confirmed Apply is writer authorship at the live-journal seam.
      // Downstream conflict and sweep classifiers deliberately derive protection
      // from this durable attribution rather than from push-specific metadata.
      originType: staged.push.pushedByUserId ? "human" : "system",
      actorUserId: staged.push.pushedByUserId,
    })
    .returning({ id: documentYjsUpdates.id });
  if (!updateRow) throw new Error(`Failed to complete staged push ${pushId}`);
  const [updated] = await db
    .update(pushLineage)
    .set({ upstreamUpdateSeq: updateRow.id })
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
  const journalRows =
    staged.push.journalIds.length > 0
      ? await db
          .select()
          .from(branchWriteJournal)
          .where(inArray(branchWriteJournal.id, staged.push.journalIds))
          .orderBy(branchWriteJournal.id)
      : [];
  if (branchRow) {
    const branch: BranchSnapshot = {
      branchId: branchRow.id,
      documentId: branchRow.documentId,
      kind: branchRow.kind,
      upstreamBranchId: branchRow.upstreamBranchId,
      workId: branchRow.workId,
      threadId: branchRow.threadId,
      pushPolicy: branchRow.pushPolicy,
      status: branchRow.status,
      generation: branchRow.generation,
      state: new Uint8Array(branchRow.state),
      stateVector: new Uint8Array(branchRow.stateVector),
      discardedStateVector: branchRow.discardedStateVector
        ? new Uint8Array(branchRow.discardedStateVector)
        : null,
      schemaVersion: branchRow.schemaVersion,
    };
    await writeMutationRows(db, branch, journalRows.map(mapJournalRow), updateRow.id);
    const durable = await deriveDurableProjection(db, documentId, durableProjectionSerializer);
    await upsertHead(db, documentId, updateRow.id, durable.stateVector);
    await refreshProjectionAndActivity(db, branch, durable.markdownProjection, new Date());
  }
  await joinAdmissionWithinTx(db, {
    documentId,
    source: { kind: "staged_push", id: String(updateRow.id) },
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
  // Apply materializes only handles whose final branch state is active. Handles
  // eliminated by Draft undo are deliberately squashed instead of being
  // recreated as active live mutations with content that no longer exists.
  const mutationRows = activeBranchAgentWriteRows(rows);
  if (mutationRows.length === 0) return;
  await db
    .insert(agentEditMutations)
    .values(
      mutationRows.map((row) => ({
        wId: row.wId,
        documentId: branch.documentId,
        threadId: row.threadId,
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

function _representativeThreadId(rows: BranchJournalRow[]): ThreadId | null {
  const ids = new Set(rows.map((row) => row.threadId));
  const [id] = ids;
  return ids.size === 1 && id !== null ? id : null;
}

function _representativeTurnId(rows: BranchJournalRow[]): TurnId | null {
  const ids = new Set(rows.map((row) => row.turnId));
  const [id] = ids;
  return ids.size === 1 && id !== null ? id : null;
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

async function readPendingSettlement(
  db: DrizzleDb,
  pushId: number,
): Promise<PendingLiveSettlement> {
  const [row] = await db
    .select({ outbox: branchPushSettlementOutbox, push: pushLineage })
    .from(branchPushSettlementOutbox)
    .innerJoin(pushLineage, eq(pushLineage.id, branchPushSettlementOutbox.pushId))
    .where(eq(branchPushSettlementOutbox.pushId, pushId))
    .limit(1);
  if (row?.outbox.state !== "pending") {
    throw new Error(`Pending branch push settlement ${pushId} is unavailable`);
  }
  const trail = parseDurableTrailSeedV1(row.outbox.trailSeed);
  if (!row.outbox.claimToken || !row.outbox.claimKind || !row.outbox.leaseExpiresAt) {
    throw new Error(`Pending branch push settlement ${pushId} is not owned`);
  }
  const updates = await db
    .select({ update: branchPushOutboxUpdates.update })
    .from(branchPushOutboxUpdates)
    .where(eq(branchPushOutboxUpdates.pushId, pushId))
    .orderBy(branchPushOutboxUpdates.ordinal);
  const provenanceDoc = createCollabYDoc({ gc: false });
  Y.applyUpdate(provenanceDoc, row.outbox.lockCutUpdate);
  for (const { update } of updates) Y.applyUpdate(provenanceDoc, update);
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
    : await readDocumentAuthorityHead(db, row.outbox.documentId);
  if (!authority) {
    provenanceDoc.destroy();
    throw new Error(`Pending branch push settlement ${pushId} has no authority admission`);
  }
  const attributedRows = await db
    .select({
      authorityId: documentYjsUpdates.authorityId,
      generation: documentYjsUpdates.authorityGeneration,
      admissionSequence: documentYjsUpdates.admissionSequence,
      batchOrdinal: documentYjsUpdates.batchOrdinal,
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
  const watermarkRow = attributedRows.at(-1);
  const retained = watermarkRow
    ? await createDrizzleProvenanceReader(db).materialize({
        documentId: row.outbox.documentId,
        authorityId: authority.authorityId,
        generation: authority.generation,
        watermark: {
          admissionSequence: watermarkRow.admissionSequence,
          batchOrdinal: watermarkRow.batchOrdinal,
          journalRowId: BigInt(watermarkRow.journalRowId),
        },
      })
    : null;
  const provenanceView = materializeProvenanceForDoc({
    doc: provenanceDoc,
    retainedAttributions: retained?.attributionManifest.attributions,
    fallbackBirthClass: "writer_protected",
    rows: attributedRows.map((attribution) => ({
      ...attribution,
      journalRowId: BigInt(attribution.journalRowId),
      update: new Uint8Array(attribution.update),
    })),
  });
  retained?.doc.destroy();
  provenanceDoc.destroy();
  return {
    push: mapLineage(row.push),
    documentTitle: row.outbox.documentTitle,
    lockCutUpdate: row.outbox.lockCutUpdate,
    pushUpdate: row.outbox.pushUpdate,
    postCutUpdates: updates.map(({ update }) => update),
    beforeContentRef: row.outbox.beforeContentRef,
    trail,
    provenanceView,
    joinVersion: row.outbox.joinVersion,
    settledJoinVersion: row.outbox.settledJoinVersion,
    claim: {
      token: row.outbox.claimToken,
      epoch: row.outbox.claimEpoch,
      kind: row.outbox.claimKind,
      leaseExpiresAt: row.outbox.leaseExpiresAt,
    },
    attemptCount: row.outbox.attemptCount,
    state: "pending",
  };
}

function ownerPredicate(pushId: number, claim: SettlementClaim, joinVersion?: number) {
  return and(
    eq(branchPushSettlementOutbox.pushId, pushId),
    eq(branchPushSettlementOutbox.state, "pending"),
    eq(branchPushSettlementOutbox.claimToken, claim.token),
    eq(branchPushSettlementOutbox.claimEpoch, claim.epoch),
    sql`${branchPushSettlementOutbox.leaseExpiresAt} > clock_timestamp()`,
    joinVersion === undefined ? undefined : eq(branchPushSettlementOutbox.joinVersion, joinVersion),
  );
}

async function databaseLease(db: DrizzleDb): Promise<{ now: Date; expiresAt: Date }> {
  const result = await db.execute(sql`
    WITH db_clock AS (SELECT clock_timestamp() AS now)
    SELECT now, now + interval '30 seconds' AS expires_at FROM db_clock
  `);
  const row = result[0] as { now: Date | string; expires_at: Date | string } | undefined;
  if (!row) throw new Error("Database clock did not return a settlement lease");
  return { now: new Date(row.now), expiresAt: new Date(row.expires_at) };
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
    .where(
      and(
        eq(branchPushSettlementOutbox.documentId, input.documentId),
        ne(branchPushSettlementOutbox.state, "completed"),
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
        settledJoinVersion: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(branchPushSettlementOutbox.pushId, target.pushId));
    joined += 1;
  }
  return joined;
}

async function deriveDurableProjection(
  db: DrizzleDb,
  documentId: DocumentId,
  durableProjectionSerializer: DurableProjectionSerializer,
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
  try {
    if (checkpoint) Y.applyUpdate(doc, checkpoint.state);
    for (const row of rows) Y.applyUpdate(doc, row.updateData);
    const markdownProjection = await durableProjectionSerializer.serializeDocument(documentId, doc);
    return {
      markdownProjection,
      stateVector: Y.encodeStateVector(doc),
    };
  } finally {
    doc.destroy();
  }
}

async function materializeDurableDocumentBefore(
  db: DrizzleDb,
  documentId: DocumentId,
  beforeUpdateSeq: number,
): Promise<Y.Doc> {
  const [checkpoint] = await db
    .select()
    .from(documentYjsCheckpoints)
    .where(
      and(
        eq(documentYjsCheckpoints.documentId, documentId),
        lt(documentYjsCheckpoints.upToSeq, beforeUpdateSeq),
      ),
    )
    .orderBy(desc(documentYjsCheckpoints.upToSeq), desc(documentYjsCheckpoints.id))
    .limit(1);
  const rows = await db
    .select({ id: documentYjsUpdates.id, update: documentYjsUpdates.updateData })
    .from(documentYjsUpdates)
    .where(
      and(
        eq(documentYjsUpdates.documentId, documentId),
        lt(documentYjsUpdates.id, beforeUpdateSeq),
        checkpoint ? sql`${documentYjsUpdates.id} > ${checkpoint.upToSeq}` : undefined,
      ),
    )
    .orderBy(documentYjsUpdates.id);
  const doc = createCollabYDoc({ gc: false });
  if (checkpoint) Y.applyUpdate(doc, checkpoint.state);
  for (const row of rows) Y.applyUpdate(doc, row.update);
  return doc;
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
