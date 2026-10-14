/**
 * Durable pushes into live documents: a content Apply is a merge (contract §2, `draft-apply.ts`).
 *
 * Under the text branches' sorted leases the push catches each draft up to live's certified cut,
 * freezes what the writer asked for (a snapshot of the draft room), and, under the live document
 * locks, plans the merge against the lock cut. A plan stages as one content member of one settlement
 * batch beside the publication steps' payloads; `not_found` and `failed` stage no member, and `already_live` stages one with an empty live write
 * and ride in the payload the tree step answers the command from. Settlement (`branch-push-transition`)
 * replans each member against the live it publishes over and patches the draft's base in the same
 * transaction, so a live move since staging never refuses: the merge is recomputed.
 */
import { randomUUID } from "node:crypto";
import {
  blocksEqual,
  DRAFT_SERVER_CLIENT_ID,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { DraftApplyFailure, DraftDecidedOutcome } from "@meridian/contracts/drafts";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import { type BranchLockLease, createBranchCriticalSections } from "./branch-critical-sections.js";
import {
  BranchPushCommitConflictError,
  BranchPushRetryExhaustedError,
  type BranchPushService,
  type BranchPushServiceInput,
  type PendingLiveSettlement,
  type PreparedPushCommit,
  type ReplannedMember,
} from "./branch-push-contracts.js";
import { preparePushUnderLiveLock } from "./branch-push-preparation.js";
import {
  createBranchPushTransition,
  PublicationLeasesChangedError,
} from "./branch-push-transition.js";
import { buildDurablePushTrail } from "./branch-trail-projection.js";
import { collabHook } from "./collab-test-hooks.js";
import { type ContentMemberInput, freezeContentInput, planContentApply } from "./draft-apply.js";
import { draftDiffersFromBase, draftSchema } from "./draft-rebase.js";
import type { DurableTrailRecord } from "./ports/change-trail-persistence.js";
import type { BaseWrite, PublicationRefusal } from "./ports/settlement-publication.js";

const maxCasRetries = 3;
/** How many times one call leases a grown set before handing its batch to recovery. */
const MAX_LEASE_REDISCOVERIES = 3;

/** A member's text branch closed (item or Discard all) between the plan and its lease. */
class MemberBranchClosedError extends Error {}

/** The idempotency key of one content member: one per command and branch. */
export function contentIdempotencyKey(commandId: string, branchId: string): string {
  return `content:${commandId}:${branchId}`;
}

type Planned = {
  branch: BranchSnapshot;
  itemKey: string;
  input: ContentMemberInput;
};

type StageResult = { refused?: PublicationRefusal; commandExists?: true };

export function createBranchPushService(inputDeps: BranchPushServiceInput): BranchPushService {
  const input = inputDeps;
  const criticalSections = input.criticalSections ?? createBranchCriticalSections();
  const prepareDeps = { model: input.model, codec: input.codec, links: input.links };

  async function resolveDocumentTitle(documentId: DocumentId): Promise<string> {
    const resolved = (await input.resolveDocumentTitle?.(documentId))?.trim();
    return resolved || "Untitled document";
  }

  /** The trail of a content member: live before and after the write, owned by the draft's pending rows. */
  async function contentTrail(args: {
    branch: BranchSnapshot;
    lockCutUpdate: Uint8Array;
    pushUpdate: Uint8Array;
    idempotencyKey: string;
    receiptId: string;
    documentTitle: string;
  }): Promise<DurableTrailRecord> {
    const rows = await input.journalReadStore.listReviewableJournalRows(
      args.branch.branchId,
      args.branch.generation,
    );
    const prepared = await preparePushUnderLiveLock(
      prepareDeps,
      {
        branch: args.branch,
        rows,
        pushUpdate: args.pushUpdate,
        idempotencyKey: args.idempotencyKey,
        receiptId: args.receiptId,
      },
      args.lockCutUpdate,
    );
    return buildDurablePushTrail({ prepared, documentTitle: args.documentTitle });
  }

  /**
   * The text branch's base patch for a merged base, against the state read under the held lease.
   * Written as the reserved server client over the state it will CAS onto: nothing stored is replayed.
   */
  function baseWriteFor(
    branch: BranchSnapshot,
    baseBlocks: readonly PMNode[],
    advanceRevision: boolean,
  ): BaseWrite {
    if (branch.status !== "active") return { kind: "none" };
    const doc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(doc, branch.state);
      const fragment = doc.getXmlFragment(REVIEW_BASE_FRAGMENT);
      if (blocksEqual(readBlocks(fragment, draftSchema), baseBlocks)) return { kind: "none" };
      const before = Y.encodeStateVector(doc);
      doc.clientID = DRAFT_SERVER_CLIENT_ID;
      doc.transact(() => writeBlocks(fragment, draftSchema, baseBlocks), "apply-base");
      return {
        kind: "patch",
        expectedState: branch.state,
        state: Y.encodeStateAsUpdate(doc),
        stateVector: Y.encodeStateVector(doc),
        update: Y.encodeStateAsUpdate(doc, before),
        hasEffect: draftDiffersFromBase(doc),
        advanceRevision,
      };
    } finally {
      doc.destroy();
    }
  }

  /** Replans one staged member against the live it will publish over (contract §2.3 step 1 and 2). */
  async function replan(args: {
    pending: PendingLiveSettlement;
    finalPrePush: Y.Doc;
  }): Promise<ReplannedMember> {
    const { pending, finalPrePush } = args;
    const { push } = pending;
    if (!push.branchId || !push.input) {
      throw new Error(`Staged push ${push.id} has no content input to replan`);
    }
    const branch = await input.branchStore.getBranch(push.branchId);
    if (!branch) throw new Error(`Staged push ${push.id} lost its text branch`);
    const liveState = Y.encodeStateAsUpdate(finalPrePush);
    const planned = planContentApply({
      input: push.input,
      branchState: branch.state,
      liveState,
    });
    // The snapshot a member froze at staging always rebuilds: branch docs keep full history.
    if (planned.status === "not_found") {
      throw new Error(`Staged push ${push.id} can no longer rebuild what it was asked to apply`);
    }
    if (planned.status === "already_live") {
      return {
        pushId: push.id,
        outcome: { status: "already_live" },
        base: baseWriteFor(branch, planned.baseBlocks, planned.baseIsLive),
      };
    }
    const { plan } = planned;
    const unchanged = bytesEqual(plan.pushUpdate, pending.pushUpdate);
    const trail = unchanged
      ? pending.trail
      : await contentTrail({
          branch,
          lockCutUpdate: liveState,
          pushUpdate: plan.pushUpdate,
          idempotencyKey: push.idempotencyKey,
          receiptId: pending.trail.receiptId,
          documentTitle: pending.documentTitle,
        });
    return {
      pushId: push.id,
      outcome: { status: "applied", pushUpdate: plan.pushUpdate, trail, overrode: plan.overrode },
      base: baseWriteFor(branch, plan.baseBlocks, plan.baseIsLive),
    };
  }

  const transition = createBranchPushTransition({
    commitStore: input.commitStore,
    settlementStore: input.settlementStore,
    liveCoordinator: input.liveCoordinator,
    codec: input.codec,
    links: input.links,
    changeEventDelivery: input.changeEventDelivery,
    writerIngressBarrier: input.writerIngressBarrier,
    criticalSections,
    content: {
      replan,
      publishBranchUpdate(branchId, update) {
        input.branchCoordinator?.broadcastUpdate?.({ branchId, update });
      },
    },
  });

  /**
   * Leases the text branches being published and any branches publication steps declared
   * (`extraBranchIds`, from their payloads), then revalidates the text branches under it.
   */
  async function withActiveWorkDraftBranchLock<T>(
    branchIds: readonly string[],
    run: (
      branches: readonly BranchSnapshot[],
      lease: BranchLockLease,
      leasedBranchIds: readonly string[],
    ) => Promise<T>,
    extraBranchIds: readonly string[],
  ): Promise<T> {
    const leasedBranchIds = [...new Set([...branchIds, ...extraBranchIds])].sort();
    const retryBranchId = branchIds[0];
    // A tree-only publication (no text member) leases what its steps declared and opens no
    // document scope.
    if (!retryBranchId) {
      return criticalSections.withBranches(leasedBranchIds, (lease) =>
        run([], lease, leasedBranchIds),
      );
    }
    const documentIds = await Promise.all(
      branchIds.map(
        async (branchId) =>
          assertActiveWorkDraftBranch(await input.branchStore.getBranch(branchId), branchId)
            .documentId,
      ),
    );
    // The tree is independent of branch state. Open the scope before any lock, then
    // revalidate every branch under its lock.
    return input.links.within({ documentId: documentIds[0] as string, documentIds }, async () => {
      for (let attempt = 0; attempt <= maxCasRetries; attempt += 1) {
        try {
          return await criticalSections.withBranches(leasedBranchIds, async (lease) => {
            const branches = await Promise.all(
              branchIds.map(async (branchId) =>
                assertActiveWorkDraftBranch(await input.branchStore.getBranch(branchId), branchId),
              ),
            );
            return run(branches, lease, leasedBranchIds);
          });
        } catch (cause) {
          if (cause instanceof BranchPushCommitConflictError) {
            if (attempt >= maxCasRetries) {
              throw new BranchPushRetryExhaustedError(cause.branchId, maxCasRetries, cause);
            }
            continue;
          }
          throw cause;
        }
      }
      throw new BranchPushRetryExhaustedError(retryBranchId, maxCasRetries);
    });
  }

  type PushInput = Parameters<BranchPushService["pushBranchesToLive"]>[0];

  /**
   * Steps 1 to 4 of §2.2 for each member, under the leases: nothing unfinished on its document,
   * a base to compare with, the catch-up rebase on the certified live cut, and the frozen input.
   */
  async function prepareMembers(
    pushInput: PushInput,
    branches: readonly BranchSnapshot[],
    lease: BranchLockLease,
  ): Promise<{ planned: Planned[]; decided: DraftDecidedOutcome[] }> {
    const planned: Planned[] = [];
    const decided: DraftDecidedOutcome[] = [];
    const failed = (itemKey: string, reason: DraftApplyFailure) =>
      decided.push({ itemKey, status: "failed", reason });
    for (const [index, member] of pushInput.members.entries()) {
      const branch = branches[index] as BranchSnapshot;
      // The catch-up rebase refuses a branch with no base and one an unfinished batch fences.
      const rebased = await input.draftRebase.catchUp(lease, branch.branchId);
      if (rebased.kind === "fenced") {
        failed(member.itemKey, "settlement_unfinished");
        continue;
      }
      if (rebased.kind === "failed") {
        failed(member.itemKey, rebased.reason);
        continue;
      }
      // After the rebase: the state the input is frozen against and the plan reads.
      const fresh = await input.branchStore.getBranch(member.branchId);
      if (fresh?.kind !== "work_draft" || fresh.status !== "active") {
        throw new MemberBranchClosedError(member.branchId);
      }
      planned.push({
        branch: fresh,
        itemKey: member.itemKey,
        input: freezeContentInput(member.request, fresh.state),
      });
    }
    // Catch-up read; the lock cut is not yet taken: where a test lets live move between them.
    await collabHook("applyItems.afterCatchUp");
    return { planned, decided };
  }

  /** Stages the planned members and the payloads as one batch, then settles it. */
  async function stageAndSettle(
    pushInput: PushInput,
    branches: readonly BranchSnapshot[],
    lease: BranchLockLease,
    leasedBranchIds: readonly string[],
  ): Promise<StageResult> {
    const { planned, decided } = await prepareMembers(pushInput, branches, lease);
    const receiptId = randomUUID();
    return transition
      .execute<StageResult>({
        documentIds: planned.map((member) => member.branch.documentId),
        ...(pushInput.signal ? { signal: pushInput.signal } : {}),
        prepare: async ({ lockCuts }) => {
          const pushes: PreparedPushCommit[] = [];
          for (const member of planned) {
            const { branch } = member;
            const lockCutUpdate = lockCuts.get(branch.documentId) as Uint8Array;
            let result: ReturnType<typeof planContentApply>;
            try {
              await collabHook("applyItems.planning");
              result = planContentApply({
                input: member.input,
                branchState: branch.state,
                liveState: lockCutUpdate,
              });
            } catch {
              // The catch-up rebase stays committed; nothing of this Apply does.
              input.mergeFailed?.({ branchId: branch.branchId, documentId: branch.documentId });
              decided.push({ itemKey: member.itemKey, status: "failed", reason: "merge_failed" });
              continue;
            }
            if (result.status === "not_found") {
              decided.push({ itemKey: member.itemKey, status: result.status });
              continue;
            }
            // A change live already reads still owes its branch a base write: it stages as an
            // ordinary member whose live write is empty, and settlement's replan carries the
            // base through the leased, projection-wrapped CAS (or publishes, if live moved on).
            const pushUpdate = result.status === "plan" ? result.plan.pushUpdate : emptyUpdate();
            const idempotencyKey = contentIdempotencyKey(
              pushInput.command.commandId,
              branch.branchId,
            );
            const documentTitle = await resolveDocumentTitle(branch.documentId);
            const trail = await contentTrail({
              branch,
              lockCutUpdate,
              pushUpdate,
              idempotencyKey,
              receiptId,
              documentTitle,
            });
            pushes.push({
              branch,
              input: member.input,
              pushUpdate,
              idempotencyKey,
              receiptId,
              ...(pushInput.pushedByUserId ? { pushedByUserId: pushInput.pushedByUserId } : {}),
              trail,
              documentTitle,
              lockCutUpdate,
            });
          }
          return {
            kind: "push" as const,
            pushes,
            payloads: pushInput.finalizePayloads(decided),
            leasedBranchIds,
            lease,
            command: pushInput.command,
            afterDurableCommit: input.hooks?.afterDurableCommit,
            // A lineage that already exists is this command's: the stored row answers.
            onConflict: () => ({ commandExists: true as const }),
            onCommandExists: () => ({ commandExists: true as const }),
            finish: ({ outcome }): StageResult =>
              outcome.kind === "refused"
                ? { refused: outcome.reason }
                : outcome.kind === "command_exists"
                  ? { commandExists: true }
                  : {},
          };
        },
      })
      .catch((cause: unknown) => {
        if (cause instanceof PublicationLeasesChangedError) {
          throw new StagedBatchResume(cause);
        }
        throw cause;
      });
  }

  /** Settles the batch this call staged and still owns, under the grown lease set (F22). */
  async function continueStaged(
    resume: StagedBatchResume,
    lease: BranchLockLease,
    leasedBranchIds: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<StageResult> {
    // The grown set is leased, the batch not yet continued: where a test grows it again.
    await collabHook("applyItems.beforeContinue");
    return transition
      .continueStaged<StageResult>({
        staged: resume.handoff.staged,
        leasedBranchIds,
        lease,
        ...(signal ? { signal } : {}),
        finish: ({ outcome }): StageResult =>
          outcome.kind === "refused" ? { refused: outcome.reason } : {},
      })
      .catch((cause: unknown) => {
        if (cause instanceof PublicationLeasesChangedError) resume.handoff = cause;
        throw cause instanceof PublicationLeasesChangedError ? resume : cause;
      });
  }

  /**
   * Publishes an Apply as one batch. When completion needs leases this call doesn't hold (a
   * model write grew the draft it may close), the call keeps the batch it staged, releases its
   * leases, leases the grown set in global order and continues that batch: the writer gets the
   * real result, and the late item stays in the draft (F22).
   */
  const pushBranchesToLive: BranchPushService["pushBranchesToLive"] = async (pushInput) => {
    // The outer preparation: branches the publication steps declare from their payloads.
    let extraBranchIds = await input.settlementStore.prepareBranchLeases(
      new Map(Object.entries(pushInput.payloads)),
    );
    const branchIds = pushInput.members.map((member) => member.branchId);
    let resume: StagedBatchResume | null = null;
    for (let rediscovered = 0; ; rediscovered += 1) {
      try {
        const staged = resume;
        return await withActiveWorkDraftBranchLock(
          branchIds,
          (branches, lease, leasedBranchIds) =>
            staged
              ? continueStaged(staged, lease, leasedBranchIds, pushInput.signal)
              : stageAndSettle(pushInput, branches, lease, leasedBranchIds),
          extraBranchIds,
        );
      } catch (cause) {
        // A text branch closed under the plan (item Discard): the writer's view was stale.
        if (cause instanceof MemberBranchClosedError) {
          return { refused: { code: "stale", detail: { itemKeys: [] } } };
        }
        if (!(cause instanceof StagedBatchResume)) throw cause;
        if (rediscovered >= MAX_LEASE_REDISCOVERIES) {
          // Hand it to recovery, which discovers its leases on its own.
          await input.settlementStore.recordFailure({
            batchId: cause.handoff.staged.batchId,
            claim: cause.handoff.staged.claim,
            stage: "handoff",
            error: "publication branch leases kept changing",
          });
          throw cause.handoff;
        }
        resume = cause;
        extraBranchIds = [...new Set([...extraBranchIds, ...cause.handoff.branchIds])].sort();
      }
    }
  };

  return {
    pushBranchesToLive,
    recoverPendingLiveSettlements: transition.recover,
    settleUnfinished: transition.settleUnfinished,
  };
}

/**
 * A staged batch the call still owns, carried out of its leases so it can lease the grown
 * set and continue: the transition's handoff.
 */
class StagedBatchResume extends Error {
  constructor(public handoff: PublicationLeasesChangedError) {
    super(handoff.message);
    this.name = "StagedBatchResume";
  }
}

function assertActiveWorkDraftBranch(
  branch: BranchSnapshot | null | undefined,
  branchId: string,
): BranchSnapshot {
  if (branch?.kind !== "work_draft" || branch.status !== "active") {
    throw new MemberBranchClosedError(branchId);
  }
  return branch;
}

/** A Yjs update that changes nothing: the live write of a member live already reads. */
function emptyUpdate(): Uint8Array {
  const doc = createCollabYDoc({ gc: false });
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
