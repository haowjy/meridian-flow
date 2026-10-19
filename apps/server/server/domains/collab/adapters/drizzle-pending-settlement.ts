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
} from "@meridian/database/schema";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import {
  currentDrizzleDb,
  isInDrizzleTransaction,
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { branchDraftRefs } from "../../../shared/work-branch-lifecycle.js";
import type { NoticePort } from "../../notices/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import {
  type ApplyPayloads,
  FIRST_CLAIM_EPOCH,
  type PendingLiveSettlement,
  type PendingSettlementBatch,
  type PreparedPushCommit,
  type PushLineageRow,
  type SettlementBatchIdentity,
  type SettlementClaim,
} from "../domain/branch-push-contracts.js";
import {
  type ChangeTrailPersistence,
  type CommittedChangeTrailProjection,
  DurableTrailSeedError,
} from "../domain/ports/change-trail-persistence.js";
import type { DocumentDerivationStore } from "../domain/ports/document-derivations.js";
import type { DocumentProjectionEffects } from "../domain/ports/document-projection-effects.js";
import type { DurableProjectionSerializer } from "../domain/ports/durable-projection.js";
import type {
  BatchCompletion,
  BatchCompletionMember,
  PendingSettlementStore,
  SettlementFailureStage,
} from "../domain/ports/pending-settlement-store.js";
import type {
  ApplyItemHold,
  ApplyRefusal,
  StagedApplyMember,
} from "../domain/ports/settlement-apply.js";
import { joinAdmissionWithinTx } from "./drizzle-settlement-admission.js";
import {
  decideAdmission,
  decideCheck,
  type PlannedStep,
  planAndLock,
  type SettlementApply,
} from "./drizzle-settlement-apply.js";
import {
  admitSettlementMemberWithinTx,
  readSettlementCuts,
  readSettlementMember,
  readSettlementMembers,
  stageSettlementMemberWithinTx,
  withdrawSettlementMembersWithinTx,
} from "./drizzle-settlement-member.js";

class CompletionRetry extends Error {}

class CompletionRefusal extends Error {
  constructor(readonly reason: ApplyRefusal) {
    super(`Apply refused: ${reason.code}`);
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
  payloads: ApplyPayloads = {},
  holds: readonly ApplyItemHold[] = [],
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
  holds: readonly ApplyItemHold[],
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

async function readHolds(db: DrizzleDb, batchId: string): Promise<ApplyItemHold[]> {
  const rows = await db
    .select()
    .from(branchPushSettlementHolds)
    .where(eq(branchPushSettlementHolds.batchId, batchId))
    .orderBy(asc(branchPushSettlementHolds.itemKey));
  return rows.map((row) => ({
    itemKey: row.itemKey,
    ...(row.documentId ? { documentId: row.documentId } : {}),
    reason: row.reason as ApplyRefusal,
  }));
}

export type StageSettlementBatchWithinTx = typeof stageSettlementBatchWithinTx;

export function createDrizzlePendingSettlementStore(
  db: Database,
  durableProjectionSerializer: DurableProjectionSerializer,
  projectionEffects: DocumentProjectionEffects,
  changeTrails: ChangeTrailPersistence,
  derivationStore: DocumentDerivationStore,
  notices: NoticePort | undefined,
  eventSink: EventSink | undefined,
  settlementApply: SettlementApply,
  /** Locks the Works first and reconciles the pending counts a withdrawal moves. */
  workProjection: WorkProjectionMutation,
): PendingSettlementStore {
  const memberDeps = { durableProjectionSerializer, projectionEffects, derivationStore };

  /**
   * A step refused the staged batch. Still inside completion's root transaction, with
   * every lock held and the tentative Apply rolled back to its savepoint, every
   * member goes back to review (journal rows active and counted through the Work
   * projection, trail contribution and notices retired, lineage and outbox gone) and the
   * batch ends `abandoned`, a terminal state recovery never lists. If the lease ran out
   * meanwhile the terminal UPDATE matches nothing and the whole transaction rolls back:
   * a withdrawal never commits without its terminal state.
   */
  async function abandonWithinTx(
    txDb: DrizzleDb,
    input: BatchCompletion,
    members: readonly BatchCompletionMember[],
    reason: ApplyRefusal,
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

  async function claimRecoverable(input: { batchId: string; token: string }) {
    assertRootOwnedSettlement("Settlement recovery");
    // One row, one UPDATE: two recoverers serialize on it, and only one owns the batch.
    let row: { epoch: number; leaseExpiresAt: Date | null } | undefined;
    try {
      const lease = await databaseLease(db);
      [row] = await db
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
    } catch (cause) {
      emitSettlementFailure(eventSink, { batchId: input.batchId, stage: "claim", cause });
      throw cause;
    }
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
      // Only a malformed authority the reader identified dead-ends the batch; any other
      // read error (a dropped connection) is the ordinary capped retry.
      if (cause instanceof DurableTrailSeedError) {
        await blockBatch({
          batchId: input.batchId,
          claim: claimed,
          code: "corrupt_settlement_authority",
          error: cause.message,
          stage: "claim",
        });
      } else {
        await recordFailure({
          batchId: input.batchId,
          claim: claimed,
          stage: "claim",
          error: cause,
        });
      }
      throw cause;
    }
  }

  async function recordFailure(failure: {
    batchId: string;
    claim: SettlementClaim;
    stage: SettlementFailureStage;
    error: unknown;
  }): Promise<boolean> {
    let failed: { attemptCount: number } | undefined;
    try {
      [failed] = await db
        .update(branchPushSettlementBatches)
        .set({
          attemptCount: sql`${branchPushSettlementBatches.attemptCount} + 1`,
          lastError: failure.error instanceof Error ? failure.error.message : String(failure.error),
          availableAt: sql`clock_timestamp() + make_interval(secs => least(60, power(2, least(6, ${branchPushSettlementBatches.attemptCount} + 1))::int))`,
          ...releasedClaim,
        })
        .where(batchOwnerPredicate(failure.batchId, failure.claim))
        .returning({ attemptCount: branchPushSettlementBatches.attemptCount });
    } catch (cause) {
      // The failure itself could not be recorded: say so before the error propagates.
      if (eventSink) {
        emitEvent(eventSink, {
          level: "error",
          source: "collab.settlement",
          name: "settlement.failure_record_failed",
          correlation: { batchId: failure.batchId },
          payload: { stage: failure.stage, ...unknownToEventPayload(cause) },
        });
      }
      throw cause;
    }
    if (failed) {
      emitSettlementFailure(eventSink, {
        batchId: failure.batchId,
        stage: failure.stage,
        attemptCount: failed.attemptCount,
        cause: failure.error,
      });
    }
    return Boolean(failed);
  }

  /** Every transition to `blocked` goes through here, so each one reports itself. */
  async function blockBatch(failure: {
    batchId: string;
    claim: SettlementClaim;
    code: string;
    error: string;
    stage?: SettlementFailureStage;
  }): Promise<boolean> {
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
    if (blocked && eventSink) {
      emitEvent(eventSink, {
        level: "error",
        source: "collab.settlement",
        name: "settlement.batch_blocked",
        correlation: { batchId: failure.batchId },
        payload: { code: failure.code, ...(failure.stage && { stage: failure.stage }) },
      });
    }
    return Boolean(blocked);
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
      let held: ApplyItemHold[] = [];
      let admitted: DocumentId[] = [];
      let outcome:
        | { kind: "completed"; projections: CommittedChangeTrailProjection[] }
        | { kind: "refused"; reason: ApplyRefusal };
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
            settlementApply,
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
            workProjection,
          );

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

          // Everything the Apply writes is tentative until the steps have decided: a
          // refusal rolls it back to this savepoint and abandons the batch in this same
          // transaction, so no committed state has the Apply undone without a durable
          // refusal.
          try {
            const projections = await runInDrizzleSavepoint(db, async () => {
              const applyDb = currentDrizzleDb(db);
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
              await writeHolds(applyDb, input.batchId, completionHolds, "completion");
              admitted = admittedMembers.map(({ push }) => push.documentId);
              const cuts = await readSettlementCuts(
                applyDb,
                locked.filter(({ push }) => !heldDocuments.has(push.documentId as DocumentId)),
              );

              // A member classified at its current join version refines the trail version
              // its commit installed; one joined since installs the next version, once per
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
                applyDb,
                heldMembers.map(({ push }) => push),
                notices,
                workProjection,
              );
              for (const member of admittedMembers) {
                await applyDb
                  .update(branchPushSettlementOutbox)
                  .set({
                    classifiedJoinVersion: member.joinVersion,
                    updatedAt: sql`clock_timestamp()`,
                  })
                  .where(eq(branchPushSettlementOutbox.pushId, member.push.id));
                await admitSettlementMemberWithinTx(
                  applyDb,
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
              const [completed] = await applyDb
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
              held = await readHolds(applyDb, input.batchId);
              return latestProjections(committed).filter((projection) =>
                admitted.includes(projection.documentId as DocumentId),
              );
            });
            return { kind: "completed" as const, projections };
          } catch (cause) {
            if (!(cause instanceof CompletionRefusal)) throw cause;
            admitted = [];
            await abandonWithinTx(txDb, input, members, cause.reason);
            for (const { plan } of plans) await plan.onRefused?.(cause.reason);
            return { kind: "refused" as const, reason: cause.reason };
          }
        });
      } catch (cause) {
        if (cause instanceof CompletionRetry) return { status: "retry" as const };
        throw cause;
      }
      if (outcome.kind === "refused") return { status: "refused" as const, reason: outcome.reason };
      // Committed: the root transaction above has returned.
      const admittedAfterCommit = admitted;
      await runAfterCommitEffects(
        [
          { name: "warm_rooms" as const, run: () => input.afterCommit(admittedAfterCommit) },
          ...plans.flatMap(({ plan }) =>
            plan.afterCommit
              ? [{ name: "apply_step" as const, run: plan.afterCommit.bind(plan) }]
              : [],
          ),
        ],
        input.batchId,
        eventSink,
      );
      return { status: "completed" as const, projections: outcome.projections, held };
    },

    async checkApply(input) {
      assertRootOwnedSettlement("Apply check");
      if (settlementApply.steps.length === 0) {
        return { kind: "proceed" as const, hold: [], payloads: input.payloads };
      }
      return runInDrizzleTransaction(db, async () => {
        const txDb = currentDrizzleDb(db);
        const members = [...input.members].sort((left, right) =>
          left.documentId.localeCompare(right.documentId),
        );
        const plans = await planAndLock(
          txDb,
          settlementApply,
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
          workProjection,
        );
        return decideCheck(plans, input.payloads);
      });
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

    claimRecoverableBatch: claimRecoverable,

    recordFailure,

    block: blockBatch,
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

/** Each staged member as an Apply step sees it: its push and its branch's Work. */
async function stagedMembers(
  db: DrizzleDb,
  members: readonly BatchCompletionMember[],
): Promise<StagedApplyMember[]> {
  const draftIds = members.flatMap(({ push }) => (push.draftId ? [push.draftId] : []));
  const works = await branchDraftRefs(db, draftIds);
  const workByDraft = new Map(works.map(({ id, workId }) => [id, workId]));
  return members.map(({ push }) => ({
    pushId: push.id,
    documentId: push.documentId,
    draftId: push.draftId,
    workId: (push.draftId ? (workByDraft.get(push.draftId) ?? null) : null) as WorkId | null,
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
 * The batch's after-commit effects, in order: warm rooms, then each Apply
 * step as declared. Each is awaited before the next starts. The batch is already
 * durable, so a failing effect is logged and the later, independent ones (a wake
 * hint after a failed catalog refresh) still run.
 */
async function runAfterCommitEffects(
  effects: readonly { name: "warm_rooms" | "apply_step"; run: () => void | Promise<void> }[],
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
          correlation: { batchId },
          payload: {
            effect: effect.name,
            ...unknownToEventPayload(cause),
          },
        });
      }
    }
  }
}

/** The attempt at which a still-failing batch is called stuck, once (about 8 minutes at the 60s backoff cap). */
const STUCK_ATTEMPT_THRESHOLD = 10;

/**
 * The one event for a swallowed claim or execution failure, so a batch that keeps
 * failing is never silent. The claim-lost race is not a failure and never gets here.
 */
function emitSettlementFailure(
  eventSink: EventSink | undefined,
  failure: {
    batchId: string;
    stage: SettlementFailureStage;
    attemptCount?: number;
    cause: unknown;
  },
): void {
  if (!eventSink) return;
  const stuck = failure.attemptCount === STUCK_ATTEMPT_THRESHOLD;
  emitEvent(eventSink, {
    level: stuck ? "error" : "warn",
    source: "collab.settlement",
    name: stuck ? "settlement.batch_stuck" : "settlement.batch_failed",
    correlation: { batchId: failure.batchId },
    payload: {
      stage: failure.stage,
      ...(failure.attemptCount !== undefined && { attemptCount: failure.attemptCount }),
      ...unknownToEventPayload(failure.cause),
    },
  });
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
