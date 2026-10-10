/**
 * Drizzle persistence authority for pending branch-push settlement batches: the
 * batch row's claims, the global lock order, and the one ordered completion
 * transaction. Per-member document work lives in `drizzle-settlement-member.ts`.
 *
 * Settlement is root-owned: staging, claiming and completion each commit and
 * roll back their own transactions, and warm rooms are applied only once the
 * completion transaction has committed, so none of them may join an ambient
 * transaction.
 */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branchPushSettlementBatches,
  branchPushSettlementOutbox,
  documentBranches,
  pushLineage,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import {
  currentDrizzleDb,
  isInDrizzleTransaction,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { lockWorksInIdOrder } from "../../../shared/work-lifecycle-lock.js";
import type { NoticePort } from "../../notices/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import {
  FIRST_CLAIM_EPOCH,
  type PendingLiveSettlement,
  type PendingSettlementBatch,
  type PreparedPushCommit,
  type PushLineageRow,
  type SettlementBatchIdentity,
  type SettlementClaim,
} from "../domain/branch-push-contracts.js";
import type {
  ChangeTrailPersistence,
  CommittedChangeTrailProjection,
} from "../domain/ports/change-trail-persistence.js";
import type { DocumentDerivationStore } from "../domain/ports/document-derivations.js";
import type { DocumentProjectionEffects } from "../domain/ports/document-projection-effects.js";
import type { DurableProjectionSerializer } from "../domain/ports/durable-projection.js";
import type { PendingSettlementStore } from "../domain/ports/pending-settlement-store.js";
import type {
  SettlementNamespaceLocks,
  SettlementPublicationPlan,
  SettlementPublicationStep,
} from "../domain/ports/settlement-publication.js";
import {
  admitSettlementMemberWithinTx,
  joinAdmissionWithinTx,
  readSettlementCuts,
  readSettlementMember,
  readSettlementMembers,
  stageSettlementMemberWithinTx,
} from "./drizzle-settlement-member.js";

export class AmbientSettlementTransactionError extends Error {
  constructor(operation: string) {
    super(
      `${operation} is root-owned: it commits and rolls back its own transaction and cannot join an ambient one`,
    );
    this.name = "AmbientSettlementTransactionError";
  }
}

/** Rejects a settlement operation started inside an ambient transaction, before it writes. */
export function assertRootOwnedSettlement(operation: string): void {
  if (isInDrizzleTransaction()) throw new AmbientSettlementTransactionError(operation);
}

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
    claimEpoch: FIRST_CLAIM_EPOCH,
    claimKind: "warm",
    claimedAt: lease.now,
    leaseExpiresAt: lease.expiresAt,
    availableAt: lease.now,
  });
  for (const { prepared, push } of staged) {
    await stageSettlementMemberWithinTx(db, settlement.batchId, prepared, push);
  }
}

export type StageSettlementBatchWithinTx = typeof stageSettlementBatchWithinTx;

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
  const memberDeps = { durableProjectionSerializer, projectionEffects, derivationStore };
  return {
    async joinAdmission(input) {
      await runInDrizzleTransaction(db, async () => {
        await joinAdmissionWithinTx(currentDrizzleDb(db), input);
      });
    },

    async completeBatch(input) {
      assertRootOwnedSettlement("Batch settlement completion");
      class CompletionRetry extends Error {}
      let plans: { step: number; plan: SettlementPublicationPlan }[] = [];
      let projections: CommittedChangeTrailProjection[];
      try {
        projections = await runInDrizzleTransaction(db, async () => {
          const txDb = currentDrizzleDb(db);
          const members = [...input.members].sort((left, right) =>
            left.push.documentId.localeCompare(right.push.documentId),
          );
          const pushIds = members.map((member) => member.push.id);
          const planned = await Promise.all(
            publication.steps.map((step) =>
              step.plan({ batchId: input.batchId, pushes: members.map(({ push }) => push) }),
            ),
          );
          plans = planned.flatMap((plan, step) => (plan ? [{ step, plan }] : []));

          // The global order: Work rows, namespace keys, then document locks, each
          // over the whole batch at once (file-access §5, contract §9.4).
          await lockWorksInIdOrder(txDb, [
            ...new Set([
              ...(await pushWorkIds(txDb, pushIds)),
              ...plans.flatMap(({ plan }) => plan.workIds ?? []),
            ]),
          ]);
          const namespaceDocumentIds = sortedUnique(
            plans.flatMap(({ plan }) => plan.namespaceDocumentIds ?? []),
          );
          if (namespaceDocumentIds.length > 0) {
            if (!publication.namespaces) {
              throw new Error("A publication step needs namespace locks this store cannot take");
            }
            await publication.namespaces.lockNamespaces(namespaceDocumentIds);
          }
          for (const documentId of sortedUnique([
            ...members.map(({ push }) => push.documentId),
            ...plans.flatMap(({ plan }) => plan.documentIds ?? []),
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
          // Read once, inside the transaction, under every document lock: no admission
          // can join a member between this read and commit.
          const locked = await readSettlementMembers(txDb, input.batchId);
          const lockedByPush = new Map(locked.map((member) => [member.push.id, member]));
          if (
            locked.length !== members.length ||
            members.some(
              (member) =>
                lockedByPush.get(member.push.id)?.outbox.joinVersion !== member.joinVersion,
            )
          ) {
            throw new CompletionRetry();
          }
          const cuts = await readSettlementCuts(txDb, locked);

          for (const { plan } of plans) await plan.beforeAdmission?.();
          // A member classified at its current join version refines the trail version its
          // commit published; one joined since publishes the next version, once per batch.
          const firstClassified = members.filter(
            (member) =>
              lockedByPush.get(member.push.id)?.outbox.classifiedJoinVersion !== member.joinVersion,
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
            await admitSettlementMemberWithinTx(
              txDb,
              lockedByPush.get(member.push.id) as (typeof locked)[number],
              memberDeps,
            );
          }
          for (const { plan } of plans) await plan.afterAdmission?.();

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
          return latestProjections(committed);
        });
      } catch (cause) {
        if (cause instanceof CompletionRetry) return { status: "retry" as const };
        throw cause;
      }
      // Committed: the root transaction above has returned.
      await runAfterCommitEffects(
        [
          { name: "warm rooms", run: input.afterCommit },
          ...plans.flatMap(({ step, plan }) =>
            plan.afterCommit
              ? [{ name: `publication step ${step}`, run: plan.afterCommit.bind(plan) }]
              : [],
          ),
        ],
        input.batchId,
        eventSink,
      );
      return { status: "completed" as const, projections };
    },

    async listRecoverableBatchIds() {
      assertRootOwnedSettlement("Settlement recovery");
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

    async loadSettlementBatch(input) {
      return readSettlementBatch(db, input.batchId, input.owner, eventSink);
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
      assertRootOwnedSettlement("Settlement recovery");
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
        // Ownership is the credentials this UPDATE returned; a successor's are never adopted.
        return await readSettlementBatch(db, input.batchId, claimed, eventSink);
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

/**
 * A batch and its members, only while `owner` still holds it: null once another
 * claimant, or the same token at a later epoch, owns the row.
 */
async function readSettlementBatch(
  db: DrizzleDb,
  batchId: string,
  owner: Pick<SettlementClaim, "token" | "epoch">,
  eventSink?: EventSink,
): Promise<PendingSettlementBatch | null> {
  const [batch] = await db
    .select()
    .from(branchPushSettlementBatches)
    .where(
      and(
        eq(branchPushSettlementBatches.id, batchId),
        eq(branchPushSettlementBatches.state, "pending"),
        eq(branchPushSettlementBatches.claimToken, owner.token),
        eq(branchPushSettlementBatches.claimEpoch, owner.epoch),
      ),
    )
    .limit(1);
  if (!batch?.claimToken || !batch.claimKind || !batch.leaseExpiresAt) return null;
  const members: PendingLiveSettlement[] = [];
  for (const row of await readSettlementMembers(db, batchId)) {
    members.push(await readSettlementMember(db, row, eventSink));
  }
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

/**
 * The batch's after-commit effects, in order: warm rooms, then each publication
 * step as declared. Each is awaited before the next starts. The batch is already
 * durable, so a failing effect is logged and the later, independent ones (a wake
 * hint after a failed catalog refresh) still run.
 */
async function runAfterCommitEffects(
  effects: readonly { name: string; run: () => void | Promise<void> }[],
  batchId: string,
  eventSink?: EventSink,
): Promise<void> {
  for (const effect of effects) {
    try {
      await effect.run();
    } catch (cause) {
      if (eventSink) {
        emitEvent(eventSink, {
          level: "error",
          source: "collab.settlement",
          name: "settlement.after_commit_failed",
          payload: { batchId, effect: effect.name, ...unknownToEventPayload(cause) },
        });
      }
    }
  }
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
