import { randomUUID } from "node:crypto";
/** Drizzle store for durable branch pushes into the live Yjs journal. */
import {
  parseSettlementLineageEvidenceV2,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
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
import type { MarkupCodec } from "@meridian/markup";
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { NoticePort } from "../../notices/index.js";
import type { BranchSnapshot } from "../domain/branch-coordinator.js";
import type {
  BranchJournalRow,
  BranchPushStore,
  PendingLiveSettlement,
  PreparedDiscardCommit,
  PreparedPushCommit,
  PushLineageRow,
  SettlementClaim,
} from "../domain/branch-push.js";
import { BranchPushCommitConflictError } from "../domain/branch-push.js";
import { persistDurableTrailRecord } from "../domain/branch-trail-projection.js";
import type { ChangeTrailPersistence } from "../domain/ports/change-trail-persistence.js";
import { parseDurableTrailSeedV1 } from "../domain/ports/change-trail-persistence.js";
import { materializeProvenanceForDoc } from "../domain/provenance.js";
import { allocateDocumentAdmission, readDocumentAuthority } from "./drizzle-document-authority.js";
import { lockDocumentMutation } from "./drizzle-document-mutation-lock.js";
import { createDrizzleProvenanceReader } from "./drizzle-provenance.js";

/** Global lock order for multi-document push batches — matches journal appendBatch. */
export function sortPushesByDocumentId<T extends { branch: { documentId: string } }>(
  pushes: readonly T[],
): T[] {
  return [...pushes].sort((left, right) =>
    left.branch.documentId.localeCompare(right.branch.documentId),
  );
}

async function persistRequiredTrail(
  persistence: ChangeTrailPersistence | undefined,
  prepared: PreparedPushCommit,
  push: PushLineageRow,
  notices?: NoticePort,
): Promise<void> {
  if (!persistence) throw new Error("Branch push committer requires change-trail persistence");
  await persistDurableTrailRecord(prepared.trail, push, persistence, notices);
}

async function persistPendingSettlement(
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
  const lineageEvidence = parseSettlementLineageEvidenceV2({ version: 2, items: [] });
  const trailSeed = parseDurableTrailSeedV1(prepared.pendingLiveSettlement.trail);
  const lease = await databaseLease(db);
  await db.insert(branchPushSettlementOutbox).values({
    pushId: push.id,
    documentId: push.documentId,
    documentTitle: prepared.pendingLiveSettlement.documentTitle,
    lockCutUpdate: Buffer.from(prepared.pendingLiveSettlement.lockCutUpdate),
    pushUpdate: Buffer.from(prepared.pendingLiveSettlement.pushUpdate),
    lineageEvidence,
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
      .set({ joinVersion: 1 })
      .where(eq(branchPushSettlementOutbox.pushId, push.id));
  }
}

export function createDrizzleBranchPushStore(
  db: Database,
  projection?: { model: YProsemirrorDocumentModel; codec: MarkupCodec },
  changeTrails?: ChangeTrailPersistence,
  notices?: NoticePort,
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

    async listReviewableJournalRows(branchId, generation) {
      const rows = await db
        .select()
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.branchId, branchId),
            eq(branchWriteJournal.generation, generation),
            inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
          ),
        )
        .orderBy(branchWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async listJournalRowsForTurn(input) {
      const conditions = [
        eq(branchWriteJournal.threadId, input.threadId),
        eq(branchWriteJournal.turnId, input.turnId),
      ];
      if (input.branchId) conditions.push(eq(branchWriteJournal.branchId, input.branchId));
      if (input.generation !== undefined) {
        conditions.push(eq(branchWriteJournal.generation, input.generation));
      }
      if (input.statuses && input.statuses.length > 0) {
        conditions.push(inArray(branchWriteJournal.status, [...input.statuses]));
      }
      const rows = await db
        .select()
        .from(branchWriteJournal)
        .where(and(...conditions))
        .orderBy(branchWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async listJournalRowsForBranch(input) {
      const conditions = [
        eq(branchWriteJournal.branchId, input.branchId),
        eq(branchWriteJournal.generation, input.generation),
      ];
      if (input.throughJournalId !== undefined) {
        conditions.push(sql`${branchWriteJournal.id} <= ${input.throughJournalId}`);
      }
      const rows = await db
        .select()
        .from(branchWriteJournal)
        .where(and(...conditions))
        .orderBy(branchWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async listPushLineageForTurn(input) {
      const turnRows = await db
        .select({ id: branchWriteJournal.id })
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.threadId, input.threadId),
            eq(branchWriteJournal.turnId, input.turnId),
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

    async listConcurrentJournalRows(branchId, generation, options) {
      const floor = options.afterJournalId ?? 0;
      const rows = await db
        .select({ row: branchWriteJournal })
        .from(branchWriteJournal)
        .innerJoin(documentBranches, eq(branchWriteJournal.branchId, documentBranches.id))
        .where(
          and(
            eq(documentBranches.documentId, options.documentId),
            sql`${branchWriteJournal.id} > ${floor}`,
            // Same-branch active rows and cross-branch pushed rows are both needed for
            // attribution. Cold-start scans are deliberately unbounded until we add a
            // push-ordered floor; max(journal.id) is unsound because journal ids can include
            // unpushed sibling rows and do not encode push order. Each row remains bounded
            // by its owning branch generation so reset/future-generation rows cannot leak
            // backward.
            sql`(
              (${branchWriteJournal.branchId} = ${branchId}
                AND ${branchWriteJournal.generation} <= ${generation}
                AND ${branchWriteJournal.status} IN ('active', 'pushed'))
              OR (${branchWriteJournal.branchId} <> ${branchId}
                AND ${branchWriteJournal.generation} <= ${documentBranches.generation}
                AND ${branchWriteJournal.status} = 'pushed')
            )`,
          ),
        )
        .orderBy(branchWriteJournal.id);
      return rows.map(({ row }) => mapJournalRow(row));
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
        const lineage = await commitPreparedPush(txDb, input, now);
        const push = mapLineage(lineage);
        await persistRequiredTrail(changeTrails, input, push, notices);
        await persistPendingSettlement(txDb, input, push);
        return {
          status: "inserted" as const,
          push,
        };
      });
    },

    async settlePushTrail(input) {
      return runInDrizzleTransaction(db, async () => {
        const txDb = currentDrizzleDb(db);
        if (!changeTrails)
          throw new Error("Branch push committer requires change-trail persistence");
        await lockDocumentMutation(txDb, input.push.documentId);
        const [owned] = await txDb
          .select({ pushId: branchPushSettlementOutbox.pushId })
          .from(branchPushSettlementOutbox)
          .where(ownerPredicate(input.push.id, input.claim, input.joinVersion))
          .for("update")
          .limit(1);
        if (!owned) return false;
        if (input.trail) {
          await persistDurableTrailRecord(input.trail, input.push, changeTrails, notices);
        }
        const [settled] = await txDb
          .update(branchPushSettlementOutbox)
          .set({ settledJoinVersion: input.joinVersion, updatedAt: sql`clock_timestamp()` })
          .where(ownerPredicate(input.push.id, input.claim, input.joinVersion))
          .returning({ pushId: branchPushSettlementOutbox.pushId });
        return Boolean(settled);
      });
    },

    async listPendingLiveSettlements() {
      const rows = await db
        .select({ outbox: branchPushSettlementOutbox, push: pushLineage })
        .from(branchPushSettlementOutbox)
        .innerJoin(pushLineage, eq(pushLineage.id, branchPushSettlementOutbox.pushId))
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
      return Promise.all(rows.map(({ outbox }) => readPendingSettlement(db, outbox.pushId)));
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
          await completeStagedPush(txDb, input.pushId, input.documentId, projection);
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

    async renewSettlementClaim(input) {
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

    async handoffSettlementClaim(input) {
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

    async recordLiveSettlementFailure(failure) {
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

    async blockLiveSettlement(failure) {
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

    async commitDiscard(input) {
      return runInDrizzleTransaction(db, async () => {
        await commitPreparedDiscard(currentDrizzleDb(db), input, new Date());
      });
    },

    async commitTurnRedo(input) {
      return runInDrizzleTransaction(db, async () => {
        await commitPreparedRedo(currentDrizzleDb(db), input, new Date());
        if (!changeTrails)
          throw new Error("Branch push committer requires change-trail persistence");
        await changeTrails.reopenOwners(trailOwnersForRows(input.journalRows));
      });
    },

    async commitPushBatch(input) {
      return runInDrizzleTransaction(db, async () => {
        const txDb = currentDrizzleDb(db);
        const pushes = sortPushesByDocumentId(input.pushes);
        for (const push of pushes) {
          const existing = await findLineage(txDb, push.idempotencyKey);
          if (existing) throw new BranchPushCommitConflictError(push.branch.branchId);
        }
        const now = new Date();
        const rows = [];
        for (const push of pushes) {
          const lineage = await commitPreparedPush(txDb, push, now);
          rows.push(lineage);
          const mapped = mapLineage(lineage);
          await persistRequiredTrail(changeTrails, push, mapped, notices);
          await persistPendingSettlement(txDb, push, mapped);
        }
        const mappedPushes = rows.map(mapLineage);
        return {
          pushes: mappedPushes,
        };
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
            eq(branchWriteJournal.generation, input.generation),
            eq(branchWriteJournal.status, "active"),
          ),
        )
        .returning({ id: branchWriteJournal.id });
      return rows.length;
    },
  };
}

async function commitPreparedDiscard(
  db: DrizzleDb,
  input: PreparedDiscardCommit,
  now: Date,
): Promise<void> {
  const [casRow] = await db
    .update(documentBranches)
    .set({
      state: Buffer.from(input.state),
      stateVector: Buffer.from(input.stateVector),
      updatedAt: now,
    })
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

  const discardedRows = await db
    .update(branchWriteJournal)
    .set({
      status: "discarded",
      reviewedBy: input.reviewedByUserId ?? null,
      reviewedAt: now,
    })
    .where(
      and(
        eq(branchWriteJournal.branchId, input.branch.branchId),
        eq(branchWriteJournal.generation, input.branch.generation),
        inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
        inArray(
          branchWriteJournal.id,
          input.journalRows.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: branchWriteJournal.id });
  if (discardedRows.length !== input.journalRows.length) {
    throw new BranchPushCommitConflictError(input.branch.branchId);
  }
}

async function commitPreparedRedo(
  db: DrizzleDb,
  input: PreparedDiscardCommit,
  now: Date,
): Promise<void> {
  const [casRow] = await db
    .update(documentBranches)
    .set({
      state: Buffer.from(input.state),
      stateVector: Buffer.from(input.stateVector),
      updatedAt: now,
    })
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

  let restoredCount = 0;
  for (const row of input.journalRows) {
    const replacement = input.replacementUpdateDataByJournalId?.get(row.id);
    const [restored] = await db
      .update(branchWriteJournal)
      .set({
        status: "active",
        ...(replacement
          ? { updateData: Buffer.from(replacement) }
          : input.replacementUpdateData
            ? { updateData: Buffer.from(input.replacementUpdateData) }
            : {}),
        reviewedBy: input.reviewedByUserId ?? null,
        reviewedAt: now,
      })
      .where(
        and(
          eq(branchWriteJournal.branchId, input.branch.branchId),
          eq(branchWriteJournal.generation, input.branch.generation),
          eq(branchWriteJournal.status, "discarded"),
          eq(branchWriteJournal.id, row.id),
        ),
      )
      .returning({ id: branchWriteJournal.id });
    if (restored) restoredCount += 1;
  }
  if (restoredCount !== input.journalRows.length) {
    throw new BranchPushCommitConflictError(input.branch.branchId);
  }
}

function trailOwnersForRows(
  rows: PreparedDiscardCommit["journalRows"],
): Array<
  | { kind: "shared"; threadId: string; turnId: null }
  | { kind: "turn"; threadId: string; turnId: string }
> {
  const owners = new Map<
    string,
    | { kind: "shared"; threadId: string; turnId: null }
    | { kind: "turn"; threadId: string; turnId: string }
  >();
  for (const row of rows) {
    if (!row.threadId || !row.turnId) continue;
    owners.set(`shared:${row.threadId}`, { kind: "shared", threadId: row.threadId, turnId: null });
    owners.set(`turn:${row.threadId}:${row.turnId}`, {
      kind: "turn",
      threadId: row.threadId,
      turnId: row.turnId,
    });
  }
  return [...owners.values()];
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
  await lockDocumentMutation(db, input.branch.documentId);

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

  const [lineage] = await db
    .insert(pushLineage)
    .values({
      branchId: input.branch.branchId,
      documentId: input.branch.documentId,
      pushKind: input.receiptPayload.pushKind,
      journalIds: input.journalRows.map((row) => row.id),
      upstreamUpdateSeq: null,
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
      .set({
        status: "pushed",
        pushedAt: now,
        reviewedBy: input.pushedByUserId ?? null,
        reviewedAt: now,
      })
      .where(
        and(
          inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
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

/** Makes one staged candidate effective inside the completion-fence transaction. */
async function completeStagedPush(
  db: DrizzleDb,
  pushId: number,
  documentId: DocumentId,
  projection?: { model: YProsemirrorDocumentModel; codec: MarkupCodec },
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
    await joinStagedPushIntoOtherSettlements(
      db,
      pushId,
      documentId,
      staged.push.upstreamUpdateSeq,
      staged.outbox.pushUpdate,
    );
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
      originType: "system",
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
    if (projection) {
      const durable = await deriveDurableProjection(db, documentId, projection);
      await upsertHead(db, documentId, updateRow.id, durable.stateVector);
      await refreshProjectionAndActivity(db, branch, durable.markdownProjection, new Date());
    }
  }
  if (!projection) {
    const durable = await materializeDurableDocumentBefore(db, documentId, Number.MAX_SAFE_INTEGER);
    await upsertHead(db, documentId, updateRow.id, Y.encodeStateVector(durable));
    durable.destroy();
  }
  await joinStagedPushIntoOtherSettlements(
    db,
    pushId,
    documentId,
    updateRow.id,
    staged.outbox.pushUpdate,
  );
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

function representativeThreadId(rows: BranchJournalRow[]): ThreadId | null {
  const ids = new Set(rows.map((row) => row.threadId));
  const [id] = ids;
  return ids.size === 1 && id !== null ? id : null;
}

function representativeTurnId(rows: BranchJournalRow[]): TurnId | null {
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
  parseSettlementLineageEvidenceV2(row.outbox.lineageEvidence);
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
    : await readDocumentAuthority(db, row.outbox.documentId);
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
    deletedParentIdentities: trail.changes.flatMap((change) =>
      change.beforeBlockIdentity ? [change.beforeBlockIdentity] : [],
    ),
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

async function joinStagedPushIntoOtherSettlements(
  db: DrizzleDb,
  pushId: number,
  documentId: DocumentId,
  admissionId: number,
  update: Uint8Array,
): Promise<void> {
  const targets = await db
    .select({
      pushId: branchPushSettlementOutbox.pushId,
      ordinal: branchPushSettlementOutbox.joinVersion,
    })
    .from(branchPushSettlementOutbox)
    .where(
      and(
        eq(branchPushSettlementOutbox.documentId, documentId),
        ne(branchPushSettlementOutbox.state, "completed"),
        ne(branchPushSettlementOutbox.pushId, pushId),
      ),
    );
  for (const target of targets) {
    const inserted = await db
      .insert(branchPushOutboxUpdates)
      .values({
        pushId: target.pushId,
        ordinal: target.ordinal,
        sourceKind: "staged_push",
        sourceId: admissionId,
        update: Buffer.from(update),
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
  }
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

function aiWriteModeProjection(policy: "manual" | "auto"): "draft" | "direct" {
  return policy === "manual" ? "draft" : "direct";
}
