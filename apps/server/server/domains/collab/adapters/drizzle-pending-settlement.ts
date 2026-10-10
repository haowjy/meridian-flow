/** Drizzle persistence authority for pending branch-push settlement batches. */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
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
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import {
  currentDrizzleDb,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { lockWorksInIdOrder } from "../../../shared/work-lifecycle-lock.js";
import type { NoticePort } from "../../notices/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { BranchSnapshot } from "../domain/branch-coordinator.js";
import type {
  BranchJournalRow,
  PendingLiveSettlement,
  PendingSettlementBatch,
  PreparedPushCommit,
  PushLineageRow,
  SettlementBatchIdentity,
  SettlementClaim,
} from "../domain/branch-push-contracts.js";
import { activeBranchAgentWriteRows } from "../domain/branch-reversal-history.js";
import { deriveDocument } from "../domain/document-derivations.js";
import type {
  ChangeTrailPersistence,
  CommittedChangeTrailProjection,
} from "../domain/ports/change-trail-persistence.js";
import { parseDurableTrailSeedV1 } from "../domain/ports/change-trail-persistence.js";
import type { DocumentDerivationStore } from "../domain/ports/document-derivations.js";
import type { DocumentProjectionEffects } from "../domain/ports/document-projection-effects.js";
import type { DurableProjectionSerializer } from "../domain/ports/durable-projection.js";
import type {
  PendingSettlementStore,
  SettlementAdmission,
  SettlementCut,
} from "../domain/ports/pending-settlement-store.js";
import type {
  SettlementNamespaceLocks,
  SettlementPublicationPlan,
  SettlementPublicationStep,
} from "../domain/ports/settlement-publication.js";
import { journalInsertionRanges, ProvenanceMaterializationError } from "../domain/provenance.js";
import { materializeSweepEvidence } from "../domain/sweep-policy.js";
import { loadDocumentState } from "./document-loader.js";
import {
  allocateDocumentAdmission,
  ensureAndReadDocumentAuthorityHead,
} from "./drizzle-document-authority-head.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

/**
 * Stages every committed push of one batch under its settlement identity, inside
 * the commit transaction. The warm committer holds the first claim.
 */
export async function stageSettlementBatchWithinTx(
  db: DrizzleDb,
  settlement: SettlementBatchIdentity,
  staged: readonly { prepared: PreparedPushCommit; push: PushLineageRow }[],
): Promise<void> {
  const lease = await databaseLease(db);
  await db.insert(branchPushSettlementBatches).values({
    id: settlement.batchId,
    claimToken: settlement.claimToken,
    claimEpoch: 1,
    claimKind: "warm",
    claimedAt: lease.now,
    leaseExpiresAt: lease.expiresAt,
    availableAt: lease.now,
  });
  for (const { prepared, push } of staged) {
    await stageMemberWithinTx(db, settlement.batchId, prepared, push);
  }
}

export type StageSettlementBatchWithinTx = typeof stageSettlementBatchWithinTx;

async function stageMemberWithinTx(
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

/** Where Apply's tree work joins the completion transaction, and the locks it needs. */
export type SettlementPublication = {
  namespaces?: SettlementNamespaceLocks;
  steps: readonly SettlementPublicationStep[];
};

export function createDrizzlePendingSettlementStore(
  db: Database,
  durableProjectionSerializer: DurableProjectionSerializer,
  projectionEffects: DocumentProjectionEffects,
  changeTrails: ChangeTrailPersistence,
  derivationStore: DocumentDerivationStore,
  notices?: NoticePort,
  eventSink?: EventSink,
  publication: SettlementPublication = { steps: [] },
): PendingSettlementStore {
  return {
    async joinAdmission(input) {
      await runInDrizzleTransaction(db, async () => {
        await joinAdmissionWithinTx(currentDrizzleDb(db), input);
      });
    },

    async completeBatch(input) {
      class CompletionRetry extends Error {}
      try {
        const projections = await runInDrizzleTransaction(db, async () => {
          const txDb = currentDrizzleDb(db);
          const members = [...input.members].sort((left, right) =>
            left.push.documentId.localeCompare(right.push.documentId),
          );
          const pushIds = members.map((member) => member.push.id);
          const plans = (
            await Promise.all(
              publication.steps.map((step) =>
                step.plan({ batchId: input.batchId, pushes: members.map(({ push }) => push) }),
              ),
            )
          ).filter((plan): plan is SettlementPublicationPlan => plan !== null);

          // The global order: Work rows, namespace keys, then document locks, each
          // over the whole batch at once (file-access §5, contract §9.4).
          await lockWorksInIdOrder(txDb, [
            ...new Set([
              ...(await pushWorkIds(txDb, pushIds)),
              ...plans.flatMap((plan) => plan.workIds ?? []),
            ]),
          ]);
          const namespaceDocumentIds = sortedUnique(
            plans.flatMap((plan) => plan.namespaceDocumentIds ?? []),
          );
          if (namespaceDocumentIds.length > 0) {
            if (!publication.namespaces) {
              throw new Error("A publication step needs namespace locks this store cannot take");
            }
            await publication.namespaces.lockNamespaces(namespaceDocumentIds);
          }
          for (const documentId of sortedUnique([
            ...members.map(({ push }) => push.documentId),
            ...plans.flatMap((plan) => plan.documentIds ?? []),
          ])) {
            await lockDocumentMutation(txDb, documentId);
          }

          const [owned] = await txDb
            .select({ id: branchPushSettlementBatches.id })
            .from(branchPushSettlementBatches)
            .where(batchOwnerPredicate(input.batchId, input.claim))
            .for("update")
            .limit(1);
          if (!owned) throw new CompletionRetry();
          // Read inside the transaction, under every document lock: no admission can
          // join a member between this read and commit.
          const rows = await txDb
            .select()
            .from(branchPushSettlementOutbox)
            .where(eq(branchPushSettlementOutbox.batchId, input.batchId))
            .orderBy(asc(branchPushSettlementOutbox.documentId));
          const rowByPush = new Map(rows.map((row) => [row.pushId, row]));
          if (
            rows.length !== members.length ||
            members.some(
              (member) => rowByPush.get(member.push.id)?.joinVersion !== member.joinVersion,
            )
          ) {
            throw new CompletionRetry();
          }
          const cuts = await readSettlementCuts(txDb, rows);

          for (const plan of plans) await plan.beforeAdmission?.();
          // A member classified at its current join version refines the trail version its
          // commit published; one joined since publishes the next version, once per batch.
          const firstClassified = members.filter(
            (member) => rowByPush.get(member.push.id)?.classifiedJoinVersion !== member.joinVersion,
          );
          const refined = members.filter((member) => !firstClassified.includes(member));
          const committed: CommittedChangeTrailProjection[] = [];
          for (const [group, refineCurrentVersion] of [
            [refined, true],
            [firstClassified, false],
          ] as const) {
            if (group.length === 0) continue;
            committed.push(
              ...(await changeTrails.replacePushContributions(
                group.map((member) => ({
                  pushId: String(member.push.id),
                  replacement: member.replacement,
                })),
                { refineCurrentVersion },
              )),
            );
          }
          for (const member of firstClassified) {
            if (!member.trail.transactionalNotice) continue;
            await notices?.record({
              ...member.trail.transactionalNotice,
              data: {
                ...member.trail.transactionalNotice.data,
                pushId: String(member.push.id),
                threadId: member.push.threadId ?? null,
                turnId: member.push.turnId ?? null,
              },
            });
          }
          for (const member of members) {
            await txDb
              .update(branchPushSettlementOutbox)
              .set({ classifiedJoinVersion: member.joinVersion, updatedAt: sql`clock_timestamp()` })
              .where(eq(branchPushSettlementOutbox.pushId, member.push.id));
            await completeStagedPush(
              txDb,
              member.push.id,
              member.push.documentId,
              durableProjectionSerializer,
              projectionEffects,
              derivationStore,
            );
          }
          for (const plan of plans) await plan.afterAdmission?.();

          const decision = input.recheck(cuts);
          if (decision !== "commit" && decision !== "retry") {
            throw new Error("Batch settlement recheck must return synchronously");
          }
          if (decision === "retry") throw new CompletionRetry();
          const [completed] = await txDb
            .update(branchPushSettlementBatches)
            .set({
              state: "completed",
              completedAt: sql`clock_timestamp()`,
              claimToken: null,
              claimKind: null,
              claimedAt: null,
              leaseExpiresAt: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(batchOwnerPredicate(input.batchId, input.claim))
            .returning({ id: branchPushSettlementBatches.id });
          if (!completed) throw new CompletionRetry();
          runAfterDrizzleCommit(input.afterCommit);
          for (const plan of plans) {
            const afterCommit = plan.afterCommit;
            if (afterCommit) runAfterDrizzleCommit(() => afterCommit());
          }
          return latestProjections(committed);
        });
        return { status: "completed" as const, projections };
      } catch (cause) {
        if (cause instanceof CompletionRetry) return { status: "retry" as const };
        throw cause;
      }
    },

    async listRecoverableBatchIds() {
      const rows = await db
        .select({ id: branchPushSettlementBatches.id })
        .from(branchPushSettlementBatches)
        .where(
          and(
            eq(branchPushSettlementBatches.state, "pending"),
            sql`${branchPushSettlementBatches.availableAt} <= clock_timestamp()`,
            or(
              isNull(branchPushSettlementBatches.claimToken),
              sql`${branchPushSettlementBatches.leaseExpiresAt} <= clock_timestamp()`,
            ),
          ),
        )
        .orderBy(branchPushSettlementBatches.createdAt)
        .limit(100);
      return rows.map((row) => row.id);
    },

    async loadSettlementBatch(batchId) {
      return readSettlementBatch(db, batchId, eventSink);
    },

    async renewClaim(input) {
      const lease = await databaseLease(db);
      const [renewed] = await db
        .update(branchPushSettlementBatches)
        .set({ leaseExpiresAt: lease.expiresAt, updatedAt: lease.now })
        .where(batchOwnerPredicate(input.batchId, input.claim))
        .returning({ leaseExpiresAt: branchPushSettlementBatches.leaseExpiresAt });
      return renewed?.leaseExpiresAt
        ? { ...input.claim, leaseExpiresAt: renewed.leaseExpiresAt }
        : null;
    },

    async claimRecoverableBatch(input) {
      // One row, one UPDATE: two recoverers serialize on it, and only one owns the batch.
      const lease = await databaseLease(db);
      const [row] = await db
        .update(branchPushSettlementBatches)
        .set({
          claimToken: input.token,
          claimEpoch: sql`${branchPushSettlementBatches.claimEpoch} + 1`,
          claimKind: "recovery",
          claimedAt: sql`clock_timestamp()`,
          leaseExpiresAt: lease.expiresAt,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(branchPushSettlementBatches.id, input.batchId),
            eq(branchPushSettlementBatches.state, "pending"),
            sql`${branchPushSettlementBatches.availableAt} <= clock_timestamp()`,
            or(
              isNull(branchPushSettlementBatches.claimToken),
              sql`${branchPushSettlementBatches.leaseExpiresAt} <= clock_timestamp()`,
            ),
          ),
        )
        .returning({
          epoch: branchPushSettlementBatches.claimEpoch,
          leaseExpiresAt: branchPushSettlementBatches.leaseExpiresAt,
        });
      if (!row?.leaseExpiresAt) return null;
      const claimed: SettlementClaim = {
        token: input.token,
        epoch: row.epoch,
        kind: "recovery",
        leaseExpiresAt: row.leaseExpiresAt,
      };
      try {
        return await readSettlementBatch(db, input.batchId, eventSink);
      } catch (cause) {
        await db
          .update(branchPushSettlementBatches)
          .set({
            state: "blocked",
            lastErrorCode: "corrupt_settlement_authority",
            lastError: cause instanceof Error ? cause.message : String(cause),
            blockedAt: sql`clock_timestamp()`,
            ...releasedClaim,
          })
          .where(batchOwnerPredicate(input.batchId, claimed));
        throw cause;
      }
    },

    async recordFailure(failure) {
      const [failed] = await db
        .update(branchPushSettlementBatches)
        .set({
          attemptCount: sql`${branchPushSettlementBatches.attemptCount} + 1`,
          lastError: failure.error,
          availableAt: sql`clock_timestamp() + make_interval(secs => least(60, power(2, least(6, ${branchPushSettlementBatches.attemptCount} + 1))::int))`,
          ...releasedClaim,
        })
        .where(batchOwnerPredicate(failure.batchId, failure.claim))
        .returning({ id: branchPushSettlementBatches.id });
      return Boolean(failed);
    },

    async block(failure) {
      const [blocked] = await db
        .update(branchPushSettlementBatches)
        .set({
          state: "blocked",
          lastErrorCode: failure.code,
          lastError: failure.error,
          blockedAt: sql`clock_timestamp()`,
          ...releasedClaim,
        })
        .where(batchOwnerPredicate(failure.batchId, failure.claim))
        .returning({ id: branchPushSettlementBatches.id });
      return Boolean(blocked);
    },
  };
}

const releasedClaim = {
  claimToken: null,
  claimKind: null,
  claimedAt: null,
  leaseExpiresAt: null,
  updatedAt: sql`clock_timestamp()`,
};

/** One projection per trail and document: the last revision this transaction wrote. */
function latestProjections(
  projections: readonly CommittedChangeTrailProjection[],
): CommittedChangeTrailProjection[] {
  const latest = new Map<string, CommittedChangeTrailProjection>();
  for (const projection of projections) {
    const key = `${projection.trailId}:${projection.documentId}`;
    const current = latest.get(key);
    if (!current || current.projectionRevision < projection.projectionRevision) {
      latest.set(key, projection);
    }
  }
  return [...latest.values()];
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

/** The Works whose drafts a batch's pushes came from; none for live-only pushes. */
async function pushWorkIds(db: DrizzleDb, pushIds: readonly number[]): Promise<WorkId[]> {
  if (pushIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ workId: documentBranches.workId })
    .from(pushLineage)
    .innerJoin(documentBranches, eq(documentBranches.id, pushLineage.branchId))
    .where(inArray(pushLineage.id, [...pushIds]));
  return rows.flatMap((row) => (row.workId ? [row.workId as WorkId] : []));
}

/** Each member's lock cut and post-cut joins, read inside the completion transaction. */
async function readSettlementCuts(
  db: DrizzleDb,
  rows: readonly (typeof branchPushSettlementOutbox.$inferSelect)[],
): Promise<SettlementCut[]> {
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

/** Makes one staged push effective inside its batch's completion transaction. */
async function completeStagedPush(
  db: DrizzleDb,
  pushId: number,
  documentId: DocumentId,
  durableProjectionSerializer: DurableProjectionSerializer,
  projectionEffects: DocumentProjectionEffects,
  derivationStore: DocumentDerivationStore,
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
      store: derivationStore,
      serializer: durableProjectionSerializer,
    },
    documentId,
  );
  // Completion already owns the mutation transaction: a stale cut is not an
  // expected scheduling deferral here and must not certify push completion.
  if (derivation.status !== "derived")
    throw new Error(`Uncertified durable document for push ${pushId}: ${derivation.status}`);
  const { stateVector } = derivation;
  await upsertHead(db, documentId, canonicalRow.id, stateVector);
  await projectionEffects.applyPushCompletion({
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

function _representativeThreadId(rows: BranchJournalRow[]): ThreadId | null {
  const ids = new Set(rows.map((row) => row.threadId));
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

async function readSettlementBatch(
  db: DrizzleDb,
  batchId: string,
  eventSink?: EventSink,
): Promise<PendingSettlementBatch> {
  const [batch] = await db
    .select()
    .from(branchPushSettlementBatches)
    .where(eq(branchPushSettlementBatches.id, batchId))
    .limit(1);
  if (batch?.state !== "pending") {
    throw new Error(`Pending settlement batch ${batchId} is unavailable`);
  }
  if (!batch.claimToken || !batch.claimKind || !batch.leaseExpiresAt) {
    throw new Error(`Pending settlement batch ${batchId} is not owned`);
  }
  const rows = await db
    .select({ outbox: branchPushSettlementOutbox, push: pushLineage })
    .from(branchPushSettlementOutbox)
    .innerJoin(pushLineage, eq(pushLineage.id, branchPushSettlementOutbox.pushId))
    .where(eq(branchPushSettlementOutbox.batchId, batchId))
    .orderBy(asc(branchPushSettlementOutbox.documentId));
  const members: PendingLiveSettlement[] = [];
  for (const row of rows) members.push(await readMember(db, row, eventSink));
  return {
    batchId,
    claim: {
      token: batch.claimToken,
      epoch: batch.claimEpoch,
      kind: batch.claimKind,
      leaseExpiresAt: batch.leaseExpiresAt,
    },
    attemptCount: batch.attemptCount,
    members,
  };
}

async function readMember(
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

function batchOwnerPredicate(batchId: string, claim: SettlementClaim) {
  return and(
    eq(branchPushSettlementBatches.id, batchId),
    eq(branchPushSettlementBatches.state, "pending"),
    eq(branchPushSettlementBatches.claimToken, claim.token),
    eq(branchPushSettlementBatches.claimEpoch, claim.epoch),
    sql`${branchPushSettlementBatches.leaseExpiresAt} > clock_timestamp()`,
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
    .innerJoin(
      branchPushSettlementBatches,
      eq(branchPushSettlementBatches.id, branchPushSettlementOutbox.batchId),
    )
    .where(
      and(
        eq(branchPushSettlementOutbox.documentId, input.documentId),
        ne(branchPushSettlementBatches.state, "completed"),
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
