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
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import {
  branchPushSettlementBatches,
  branchPushSettlementHolds,
  branchPushSettlementOutbox,
  branchPushSettlementPayloads,
  documentBranches,
  pushLineage,
} from "@meridian/database/schema";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import {
  currentDrizzleDb,
  isInDrizzleTransaction,
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type { NoticePort } from "../../notices/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import {
  FIRST_CLAIM_EPOCH,
  type PendingLiveSettlement,
  type PendingSettlementBatch,
  type PreparedPushCommit,
  type PublicationPayloads,
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
import type {
  BatchCompletion,
  BatchCompletionMember,
  PendingSettlementStore,
} from "../domain/ports/pending-settlement-store.js";
import type {
  PublicationItemHold,
  PublicationRefusal,
  StagedPublicationMember,
} from "../domain/ports/settlement-publication.js";
import {
  admitSettlementMemberWithinTx,
  joinAdmissionWithinTx,
  readSettlementCuts,
  readSettlementMember,
  readSettlementMembers,
  stageSettlementMemberWithinTx,
  withdrawSettlementMembersWithinTx,
} from "./drizzle-settlement-member.js";
import {
  decideAdmission,
  decideCheck,
  type PlannedStep,
  planAndLock,
  requiredBranchLeases,
  type SettlementPublication,
} from "./drizzle-settlement-publication.js";

class CompletionRetry extends Error {}

class CompletionRefusal extends Error {
  constructor(readonly reason: PublicationRefusal) {
    super(`Publication refused: ${reason.code}`);
  }
}

class CompletionRediscover extends Error {
  constructor(readonly branchIds: readonly string[]) {
    super("Publication needs branch leases its caller doesn't hold");
  }
}

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
  payloads: PublicationPayloads = {},
  holds: readonly PublicationItemHold[] = [],
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
  const steps = Object.entries(payloads);
  if (steps.length > 0) {
    await db
      .insert(branchPushSettlementPayloads)
      .values(
        steps.map(([stepKind, payload]) => ({ batchId: settlement.batchId, stepKind, payload })),
      );
  }
  await writeHolds(db, settlement.batchId, holds, "check");
  for (const { prepared, push } of staged) {
    await stageSettlementMemberWithinTx(db, settlement.batchId, prepared, push);
  }
}

async function writeHolds(
  db: DrizzleDb,
  batchId: string,
  holds: readonly PublicationItemHold[],
  decidedIn: "check" | "completion",
): Promise<void> {
  if (holds.length === 0) return;
  await db
    .insert(branchPushSettlementHolds)
    .values(
      holds.map((hold) => ({
        batchId,
        itemKey: hold.itemKey,
        documentId: hold.documentId ?? null,
        reason: hold.reason,
        decidedIn,
      })),
    )
    // An item held at the check stays held as decided there.
    .onConflictDoNothing();
}

async function readHolds(db: DrizzleDb, batchId: string): Promise<PublicationItemHold[]> {
  const rows = await db
    .select()
    .from(branchPushSettlementHolds)
    .where(eq(branchPushSettlementHolds.batchId, batchId))
    .orderBy(asc(branchPushSettlementHolds.itemKey));
  return rows.map((row) => ({
    itemKey: row.itemKey,
    ...(row.documentId ? { documentId: row.documentId } : {}),
    reason: row.reason as PublicationRefusal,
  }));
}

export type StageSettlementBatchWithinTx = typeof stageSettlementBatchWithinTx;

export function createDrizzlePendingSettlementStore(
  db: Database,
  durableProjectionSerializer: DurableProjectionSerializer,
  projectionEffects: DocumentProjectionEffects,
  changeTrails: ChangeTrailPersistence,
  derivationStore: DocumentDerivationStore,
  notices?: NoticePort,
  eventSink?: EventSink,
  publication: SettlementPublication = { steps: [] },
  /** Publishes the Works whose pending drafts a withdrawal makes reviewable again. */
  workProjection?: WorkProjectionMutation,
): PendingSettlementStore {
  const memberDeps = { durableProjectionSerializer, projectionEffects, derivationStore };

  /**
   * A step refused the staged batch. Still inside completion's root transaction, with
   * every lock held and the tentative publication rolled back to its savepoint, every
   * member goes back to review (journal rows active and published through the Work
   * projection, trail contribution and notices retired, lineage and outbox gone) and the
   * batch ends `abandoned`, a terminal state recovery never lists. If the lease ran out
   * meanwhile the terminal UPDATE matches nothing and the whole transaction rolls back:
   * a withdrawal never commits without its terminal state.
   */
  async function abandonWithinTx(
    txDb: DrizzleDb,
    input: BatchCompletion,
    members: readonly BatchCompletionMember[],
    reason: PublicationRefusal,
  ): Promise<void> {
    if (members.length > 0) {
      await changeTrails.replacePushContributions(members.map(retiredContribution), {
        refineCurrentVersion: false,
      });
    }
    await withdrawSettlementMembersWithinTx(
      txDb,
      members.map(({ push }) => push),
      notices,
      workProjection,
    );
    const [abandoned] = await txDb
      .update(branchPushSettlementBatches)
      .set({
        state: "abandoned",
        abandonedAt: sql`clock_timestamp()`,
        lastErrorCode: reason.code,
        lastError: reason.detail === undefined ? null : JSON.stringify(reason.detail),
        ...releasedClaim,
      })
      .where(batchOwnerPredicate(input.batchId, input.claim))
      .returning({ id: branchPushSettlementBatches.id });
    if (!abandoned) throw new CompletionRetry();
  }

  return {
    async joinAdmission(input) {
      await runInDrizzleTransaction(db, async () => {
        await joinAdmissionWithinTx(currentDrizzleDb(db), input);
      });
    },

    async completeBatch(input) {
      assertRootOwnedSettlement("Batch settlement completion");
      let plans: PlannedStep[] = [];
      let held: PublicationItemHold[] = [];
      let admitted: DocumentId[] = [];
      let outcome:
        | { kind: "completed"; projections: CommittedChangeTrailProjection[] }
        | { kind: "refused"; reason: PublicationRefusal };
      try {
        outcome = await runInDrizzleTransaction(db, async () => {
          const txDb = currentDrizzleDb(db);
          const members = sortedMembers(input.members);
          // Immutable inputs, read before any lock: the members reconstructed from their
          // pushes and the items the check already held.
          const descriptors = await stagedMembers(txDb, members);
          const checkHolds = await readHolds(txDb, input.batchId);
          plans = await planAndLock(
            txDb,
            publication,
            {
              stage: "completion",
              batchId: input.batchId,
              members: descriptors,
              held: checkHolds,
              payloads: input.payloads,
              liveTextFingerprints: input.liveTextFingerprints,
            },
            {
              workIds: descriptors.flatMap(({ workId }) => (workId ? [workId] : [])),
              documentIds: descriptors.map(({ documentId }) => documentId),
            },
          );

          const [owned] = await txDb
            .select({ id: branchPushSettlementBatches.id })
            .from(branchPushSettlementBatches)
            .where(batchOwnerPredicate(input.batchId, input.claim))
            .for("update")
            .limit(1);
          if (!owned) throw new CompletionRetry();
          // The outer leases, asked again under the locks: a set that grew means discovery again.
          const leased = new Set(input.leasedBranchIds);
          const unleased = (await requiredBranchLeases(publication, input.payloads)).filter(
            (branchId) => !leased.has(branchId),
          );
          if (unleased.length > 0) throw new CompletionRediscover(unleased);
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

          // Everything the publication writes is tentative until the steps have decided: a
          // refusal rolls it back to this savepoint and abandons the batch in this same
          // transaction, so no committed state has the publication undone without a durable
          // refusal.
          try {
            const projections = await runInDrizzleSavepoint(db, async () => {
              const publicationDb = currentDrizzleDb(db);
              const admission = await decideAdmission(plans, (plan) => plan.beforeAdmission?.());
              if (admission.kind === "refuse") throw new CompletionRefusal(admission.reason);
              const completionHolds = admission.hold ?? [];
              const heldDocuments = new Set(
                completionHolds.flatMap(({ documentId }) => documentId ?? []),
              );
              const heldMembers = members.filter(({ push }) => heldDocuments.has(push.documentId));
              const admittedMembers = members.filter(
                ({ push }) => !heldDocuments.has(push.documentId),
              );
              await writeHolds(publicationDb, input.batchId, completionHolds, "completion");
              admitted = admittedMembers.map(({ push }) => push.documentId);
              const cuts = await readSettlementCuts(
                publicationDb,
                locked.filter(({ push }) => !heldDocuments.has(push.documentId as DocumentId)),
              );

              // A member classified at its current join version refines the trail version
              // its commit published; one joined since publishes the next version, once per
              // batch, together with the retired contributions of held members.
              const firstClassified = admittedMembers.filter(
                (member) =>
                  lockedByPush.get(member.push.id)?.outbox.classifiedJoinVersion !==
                  member.joinVersion,
              );
              const refined = admittedMembers.filter((member) => !firstClassified.includes(member));
              const committed: CommittedChangeTrailProjection[] = [];
              for (const [contributions, refineCurrentVersion] of [
                [refined.map(contribution), true],
                [
                  [...firstClassified.map(contribution), ...heldMembers.map(retiredContribution)],
                  false,
                ],
              ] as const) {
                if (contributions.length === 0) continue;
                committed.push(
                  ...(await changeTrails.replacePushContributions(contributions, {
                    refineCurrentVersion,
                  })),
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
              await withdrawSettlementMembersWithinTx(
                publicationDb,
                heldMembers.map(({ push }) => push),
                notices,
                workProjection,
              );
              for (const member of admittedMembers) {
                await publicationDb
                  .update(branchPushSettlementOutbox)
                  .set({
                    classifiedJoinVersion: member.joinVersion,
                    updatedAt: sql`clock_timestamp()`,
                  })
                  .where(eq(branchPushSettlementOutbox.pushId, member.push.id));
                await admitSettlementMemberWithinTx(
                  publicationDb,
                  lockedByPush.get(member.push.id) as (typeof locked)[number],
                  memberDeps,
                );
              }
              for (const { plan } of plans) await plan.afterAdmission?.(admitted);

              const decision = input.recheck(cuts);
              if (decision !== "commit" && decision !== "retry") {
                throw new Error("Batch settlement recheck must return synchronously");
              }
              if (decision === "retry") throw new CompletionRetry();
              const [completed] = await publicationDb
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
              held = await readHolds(publicationDb, input.batchId);
              return latestProjections(committed).filter((projection) =>
                admitted.includes(projection.documentId as DocumentId),
              );
            });
            return { kind: "completed" as const, projections };
          } catch (cause) {
            if (!(cause instanceof CompletionRefusal)) throw cause;
            admitted = [];
            await abandonWithinTx(txDb, input, members, cause.reason);
            return { kind: "refused" as const, reason: cause.reason };
          }
        });
      } catch (cause) {
        if (cause instanceof CompletionRetry) return { status: "retry" as const };
        if (cause instanceof CompletionRediscover) {
          return { status: "rediscover" as const, branchIds: cause.branchIds };
        }
        throw cause;
      }
      if (outcome.kind === "refused") return { status: "refused" as const, reason: outcome.reason };
      // Committed: the root transaction above has returned.
      const admittedAfterCommit = admitted;
      await runAfterCommitEffects(
        [
          { name: "warm rooms", run: () => input.afterCommit(admittedAfterCommit) },
          ...plans.flatMap(({ step, plan }) =>
            plan.afterCommit
              ? [{ name: `publication step ${step}`, run: plan.afterCommit.bind(plan) }]
              : [],
          ),
        ],
        input.batchId,
        eventSink,
      );
      return { status: "completed" as const, projections: outcome.projections, held };
    },

    async checkPublication(input) {
      assertRootOwnedSettlement("Publication check");
      if (publication.steps.length === 0) {
        return { kind: "proceed" as const, hold: [], payloads: input.payloads };
      }
      return runInDrizzleTransaction(db, async () => {
        const txDb = currentDrizzleDb(db);
        const members = [...input.members].sort((left, right) =>
          left.documentId.localeCompare(right.documentId),
        );
        const plans = await planAndLock(
          txDb,
          publication,
          {
            stage: "check",
            batchId: input.batchId,
            members,
            payloads: input.payloads,
            liveTextFingerprints: input.liveTextFingerprints,
          },
          {
            workIds: members.flatMap(({ workId }) => (workId ? [workId] : [])),
            documentIds: members.map(({ documentId }) => documentId),
          },
        );
        return decideCheck(plans, input.payloads);
      });
    },

    prepareBranchLeases(payloads) {
      return requiredBranchLeases(publication, payloads);
    },

    async loadRecoveryScope(batchId) {
      const payloads = await db
        .select({
          stepKind: branchPushSettlementPayloads.stepKind,
          payload: branchPushSettlementPayloads.payload,
        })
        .from(branchPushSettlementPayloads)
        .where(eq(branchPushSettlementPayloads.batchId, batchId));
      const members = await db
        .select({ branchId: pushLineage.branchId })
        .from(branchPushSettlementOutbox)
        .innerJoin(pushLineage, eq(pushLineage.id, branchPushSettlementOutbox.pushId))
        .where(eq(branchPushSettlementOutbox.batchId, batchId));
      return {
        payloads: new Map(
          payloads.map(({ stepKind, payload }) => [stepKind, payload as JsonValue] as const),
        ),
        memberBranchIds: members.flatMap(({ branchId }) => (branchId ? [branchId] : [])),
      };
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

function sortedMembers(members: readonly BatchCompletionMember[]): BatchCompletionMember[] {
  return [...members].sort((left, right) =>
    left.push.documentId.localeCompare(right.push.documentId),
  );
}

/** Each staged member as a publication step sees it: its push and its branch's Work. */
async function stagedMembers(
  db: DrizzleDb,
  members: readonly BatchCompletionMember[],
): Promise<StagedPublicationMember[]> {
  const branchIds = members.flatMap(({ push }) => (push.branchId ? [push.branchId] : []));
  const works =
    branchIds.length === 0
      ? []
      : await db
          .select({ branchId: documentBranches.id, workId: documentBranches.workId })
          .from(documentBranches)
          .where(inArray(documentBranches.id, branchIds));
  const workByBranch = new Map(works.map(({ branchId, workId }) => [branchId, workId]));
  return members.map(({ push }) => ({
    pushId: push.id,
    documentId: push.documentId,
    branchId: push.branchId,
    workId: (push.branchId ? (workByBranch.get(push.branchId) ?? null) : null) as WorkId | null,
    journalIds: push.journalIds,
  }));
}

function contribution(member: BatchCompletionMember) {
  return { pushId: String(member.push.id), replacement: member.replacement };
}

/** The push never reached live: its provisional contribution leaves the trail. */
function retiredContribution(member: BatchCompletionMember) {
  return { pushId: String(member.push.id), replacement: member.replacement, retire: true };
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
  const payloads = await db
    .select({
      stepKind: branchPushSettlementPayloads.stepKind,
      payload: branchPushSettlementPayloads.payload,
    })
    .from(branchPushSettlementPayloads)
    .where(eq(branchPushSettlementPayloads.batchId, batchId));
  return {
    batchId,
    claim: {
      token: batch.claimToken,
      epoch: batch.claimEpoch,
      kind: batch.claimKind,
      leaseExpiresAt: batch.leaseExpiresAt,
    },
    attemptCount: batch.attemptCount,
    payloads: new Map(
      payloads.map(({ stepKind, payload }) => [stepKind, payload as JsonValue] as const),
    ),
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
