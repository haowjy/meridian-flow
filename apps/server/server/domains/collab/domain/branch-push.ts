/** One data-driven pipeline for durable branch pushes into live documents. */
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import { type BranchLockLease, createBranchCriticalSections } from "./branch-critical-sections.js";
import { buildWholeBranchCandidates } from "./branch-push-candidates.js";
import {
  type BranchJournalRow,
  BranchPushCommitConflictError,
  BranchPushRetryExhaustedError,
  type BranchPushService,
  type BranchPushServiceInput,
  type CandidateBatch,
  type PushCandidate,
  type PushLineageRow,
  type PushToLiveResult,
} from "./branch-push-contracts.js";
import { stablePushIdempotencyKey, wholeBranchPushUpdate } from "./branch-push-plan.js";
import { preparePushUnderLiveLock } from "./branch-push-preparation.js";
import {
  createBranchPushTransition,
  PublicationLeasesChangedError,
  type PublicationOutcome,
} from "./branch-push-transition.js";
import { buildDurablePushTrail } from "./branch-trail-projection.js";
import type {
  PublicationItemHold,
  PublicationItemOutcome,
  PublicationRefusal,
} from "./ports/settlement-publication.js";

type ComputedCandidate = {
  candidate: PushCandidate;
  branch: BranchSnapshot;
  pushUpdate: Uint8Array;
  idempotencyKey: string;
};

type BatchPipelineResult =
  | { kind: "conflict"; push: PushLineageRow; phases: readonly ComputedCandidate[] }
  | { kind: "refused"; reason: PublicationRefusal; phases: readonly ComputedCandidate[] }
  | {
      kind: "committed";
      /** The pushes whose text reached live. */
      pushes: readonly PushLineageRow[];
      /** Candidates a publication step kept out of live, and why. */
      held: ReadonlyMap<DocumentId, PublicationRefusal>;
      /** Every held item, branchless ones included. */
      heldItems: readonly PublicationItemHold[];
      /** What the steps did per published item, decided in completion. */
      outcomes: readonly PublicationItemOutcome[];
      phases: readonly ComputedCandidate[];
      liveAfterPush: ReadonlyMap<DocumentId, Uint8Array>;
      /** One entry per drained branch the auto reset rebased onto live. */
      branchResets: ReadonlyMap<string, { branchId: string; fromGeneration: number }>;
    };

export function createBranchPushService(input: BranchPushServiceInput): BranchPushService {
  const criticalSections = input.criticalSections ?? createBranchCriticalSections();
  const computePushUpdate = input.pushUpdateComputer ?? wholeBranchPushUpdate;
  const transition = createBranchPushTransition({
    commitStore: input.commitStore,
    settlementStore: input.settlementStore,
    liveCoordinator: input.liveCoordinator,
    model: input.model,
    codec: input.codec,
    links: input.links,
    changeEventDelivery: input.changeEventDelivery,
    writerIngressBarrier: input.writerIngressBarrier,
    sweepProjectionDiagnostics: input.sweepProjectionDiagnostics,
    criticalSections,
  });

  async function loadLiveDoc(documentId: DocumentId): Promise<Y.Doc> {
    const snapshot = await input.journal.read(documentId);
    const doc = createCollabYDoc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    return doc;
  }

  async function listReviewableRows(
    branchId: string,
    generation: number,
  ): Promise<BranchJournalRow[]> {
    return input.journalReadStore.listReviewableJournalRows(branchId, generation);
  }

  async function computeCandidate(
    candidate: PushCandidate,
    branch: BranchSnapshot,
  ): Promise<ComputedCandidate> {
    const rows = candidate.rows;
    const liveDoc = await loadLiveDoc(branch.documentId);
    const branchDoc = materializeBranch(branch);
    try {
      const pushUpdate = computePushUpdate({ branch, branchDoc, liveDoc });
      return {
        candidate,
        branch,
        pushUpdate,
        idempotencyKey: stablePushIdempotencyKey({
          branchId: branch.branchId,
          generation: branch.generation,
          journalIds: rows.map((row) => row.id),
        }),
      };
    } finally {
      branchDoc.destroy();
      liveDoc.destroy();
    }
  }

  const prepareCandidate = (
    phase: ComputedCandidate,
    lockCutUpdate: Uint8Array,
    receiptId: string,
  ) =>
    preparePushUnderLiveLock(
      { model: input.model, codec: input.codec, links: input.links },
      {
        branch: phase.branch,
        rows: phase.candidate.rows,
        pushUpdate: phase.pushUpdate,
        idempotencyKey: phase.idempotencyKey,
        receiptId,
      },
      lockCutUpdate,
      receiptId,
    );

  async function executeCandidateBatch(
    batch: CandidateBatch,
    branches: ReadonlyMap<string, BranchSnapshot>,
    lease: BranchLockLease,
    leasedBranchIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<BatchPipelineResult> {
    if (batch.candidates.length === 0 && Object.keys(batch.payloads ?? {}).length === 0) {
      throw new Error("Candidate batch requires a push or a publication payload");
    }
    const phases = await Promise.all(
      batch.candidates.map((candidate) => {
        const branch = branches.get(candidate.branchId);
        if (!branch) throw new Error(`Candidate branch ${candidate.branchId} was not locked`);
        return computeCandidate(candidate, branch);
      }),
    );
    const locked = await transition
      .execute<BatchPipelineResult>({
        documentIds: phases.map((phase) => phase.candidate.documentId),
        signal,
        prepare: async ({ lockCuts }) => {
          const prepared = await Promise.all(
            phases.map((phase) =>
              prepareCandidate(
                phase,
                lockCuts.get(phase.candidate.documentId) as Uint8Array,
                batch.receiptId,
              ),
            ),
          );
          const titles = await Promise.all(
            phases.map((phase) => resolveDocumentTitle(phase.candidate.documentId)),
          );
          const pushes = prepared.map((candidate, index) => {
            const phase = phases[index] as ComputedCandidate;
            const documentTitle = titles[index] ?? "Untitled document";
            const trail = buildDurablePushTrail({
              prepared: candidate,
              documentTitle,
            });
            return {
              ...candidate.prepared,
              receiptId: batch.receiptId,
              pushedByUserId: batch.pushedByUserId,
              trail,
              documentTitle,
              lockCutUpdate: candidate.lockCutUpdate,
              branch: phase.branch,
            };
          });
          return {
            kind: "push" as const,
            pushes,
            ...(batch.payloads ? { payloads: batch.payloads } : {}),
            leasedBranchIds,
            afterDurableCommit: input.hooks?.afterDurableCommit,
            onConflict: (push: PushLineageRow) => ({
              kind: "conflict" as const,
              push,
              phases,
            }),
            finish: ({ outcome, docs }): BatchPipelineResult => batchResult(outcome, docs, phases),
          };
        },
      })
      .catch((cause: unknown) => {
        if (cause instanceof PublicationLeasesChangedError) {
          throw new StagedBatchResume(cause, { phases, resetPolicy: batch.resetPolicy });
        }
        throw cause;
      });
    return withAutoResets(locked, lease, phases, batch.resetPolicy);
  }

  /** A settled batch as the pipeline reports it, from the phases it staged. */
  function batchResult(
    outcome: PublicationOutcome,
    docs: ReadonlyMap<DocumentId, Y.Doc>,
    phases: readonly ComputedCandidate[],
  ): BatchPipelineResult {
    if (outcome.kind === "refused") return { kind: "refused", reason: outcome.reason, phases };
    return {
      kind: "committed",
      pushes: outcome.pushes,
      held: new Map(
        outcome.held.flatMap((held) =>
          held.documentId ? [[held.documentId, held.reason] as const] : [],
        ),
      ),
      heldItems: outcome.held,
      outcomes: outcome.outcomes,
      phases,
      liveAfterPush: new Map(
        phases.map((phase) => [
          phase.candidate.documentId,
          Y.encodeStateAsUpdate(docs.get(phase.candidate.documentId) as Y.Doc),
        ]),
      ),
      branchResets: new Map(),
    };
  }

  async function withAutoResets(
    locked: BatchPipelineResult,
    lease: BranchLockLease,
    phases: readonly ComputedCandidate[],
    resetPolicy: "auto" | undefined,
  ): Promise<BatchPipelineResult> {
    if (locked.kind !== "committed") return locked;
    const branchResets = new Map<string, { branchId: string; fromGeneration: number }>();
    if (resetPolicy === "auto") {
      // Held candidates' rows are reviewable again: their branches stay as they are.
      for (const phase of phases.filter(
        ({ candidate }) => !locked.held.has(candidate.documentId),
      )) {
        const reset = await resetAutoBranchIfDrained(
          lease,
          phase.branch,
          locked.liveAfterPush.get(phase.candidate.documentId) as Uint8Array,
        );
        if (reset) branchResets.set(reset.branchId, reset);
      }
    }
    return { ...locked, branchResets };
  }

  /**
   * Leases the drafts being pushed and any branches publication steps declared
   * (`extraBranchIds`, from their payloads), then revalidates the drafts under it.
   */
  async function withActiveWorkDraftBranchLock<T>(
    branchIds: readonly string[],
    run: (
      branches: readonly BranchSnapshot[],
      lease: BranchLockLease,
      leasedBranchIds: readonly string[],
    ) => Promise<T>,
    extraBranchIds: readonly string[] = [],
  ): Promise<T> {
    const leasedBranchIds = [...new Set([...branchIds, ...extraBranchIds])].sort();
    const retryBranchId = branchIds[0];
    // A branchless publication (payloads only) leases what its steps declared and opens no
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

  async function resetAutoBranchIfDrained(
    lease: BranchLockLease,
    branch: BranchSnapshot,
    liveAfterPush: Uint8Array,
  ): Promise<{ branchId: string; fromGeneration: number } | undefined> {
    if (!input.branchCoordinator) return undefined;
    const activeRows = await input.journalReadStore.listActiveJournalRows(
      branch.branchId,
      branch.generation,
    );
    if (activeRows.length > 0) return undefined;
    const fromGeneration = branch.generation;
    const liveDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(liveDoc, liveAfterPush);
    try {
      const reset = await input.branchCoordinator.resetFromDocIfUnchangedWithLease(lease, {
        branchId: branch.branchId,
        upstream: liveDoc,
        expectedGeneration: branch.generation,
        expectedStateVector: branch.stateVector,
        expectedState: branch.state,
        schemaVersion: branch.schemaVersion,
      });
      return reset ? { branchId: branch.branchId, fromGeneration } : undefined;
    } finally {
      liveDoc.destroy();
    }
  }

  async function sourceFor(branch: BranchSnapshot): Promise<{
    branch: BranchSnapshot;
    rows: BranchJournalRow[];
  }> {
    return {
      branch,
      rows: await listReviewableRows(branch.branchId, branch.generation),
    };
  }

  function materializeBranch(branch: BranchSnapshot): Y.Doc {
    const doc = createCollabYDoc({ gc: false });
    Y.applyUpdate(doc, branch.state);
    return doc;
  }

  /** One item per pushed candidate, keyed by its branch. */
  function mapCommitted(
    result: Extract<BatchPipelineResult, { kind: "committed" }>,
  ): ReadonlyMap<string, PushToLiveResult> {
    return new Map(
      result.phases.map((phase): [string, PushToLiveResult] => {
        const heldReason = result.held.get(phase.candidate.documentId);
        if (heldReason) {
          return [
            phase.branch.branchId,
            {
              status: "held" as const,
              branchId: phase.branch.branchId,
              documentId: phase.candidate.documentId,
              reason: heldReason,
            },
          ];
        }
        const push = result.pushes.find(
          (candidate) => candidate.documentId === phase.candidate.documentId,
        );
        if (!push) throw new Error(`Batch lost the push for ${phase.candidate.documentId}`);
        const branchReset = result.branchResets.get(phase.branch.branchId);
        return [
          phase.branch.branchId,
          {
            status: "pushed" as const,
            push,
            update: phase.pushUpdate,
            ...(branchReset ? { branchReset } : {}),
          },
        ];
      }),
    );
  }

  function mapRefused(
    result: Extract<BatchPipelineResult, { kind: "refused" }>,
  ): Extract<PushToLiveResult, { status: "refused" }>[] {
    return result.phases.map((phase) => ({
      status: "refused",
      branchId: phase.branch.branchId,
      documentId: phase.candidate.documentId,
      reason: result.reason,
    }));
  }

  type PushBranchesInput = Parameters<BranchPushService["pushBranchesToLive"]>[0];
  type PushBranchesResult = Awaited<ReturnType<BranchPushService["pushBranchesToLive"]>>;

  /** The per-branch answer in request order, from a batch's result and the branches it left out. */
  function itemsOf(
    order: readonly string[],
    unbatched: ReadonlyMap<string, PushToLiveResult>,
    result: BatchPipelineResult | null,
  ): PushBranchesResult {
    const items = new Map(unbatched);
    let refused: PublicationRefusal | undefined;
    if (result?.kind === "refused") {
      refused = result.reason;
      for (const item of mapRefused(result)) items.set(item.branchId, item);
    } else if (result?.kind === "committed") {
      for (const [branchId, item] of mapCommitted(result)) items.set(branchId, item);
    }
    return {
      items: order.map((branchId) => items.get(branchId) as PushToLiveResult),
      heldItems: result?.kind === "committed" ? result.heldItems : [],
      outcomes: result?.kind === "committed" ? result.outcomes : [],
      ...(refused ? { refused } : {}),
    };
  }

  /** Stages the branches with rows and the payloads as one batch, then settles it. */
  async function stageAndSettle(
    pushInput: PushBranchesInput,
    branches: readonly BranchSnapshot[],
    lease: BranchLockLease,
    leasedBranchIds: readonly string[],
  ): Promise<PushBranchesResult> {
    const sources = await Promise.all(branches.map(sourceFor));
    const order = sources.map((source) => source.branch.branchId);
    const drafted = sources.filter((source) => source.rows.length > 0);
    const unbatched = new Map<string, PushToLiveResult>();
    for (const source of sources) {
      if (source.rows.length > 0) continue;
      unbatched.set(source.branch.branchId, mapNoActiveRows(await noActiveRows(source.branch)));
    }
    if (drafted.length === 0 && Object.keys(pushInput.payloads ?? {}).length === 0) {
      return itemsOf(order, unbatched, null);
    }
    const batch = buildWholeBranchCandidates({
      sources: drafted,
      ...(pushInput.payloads ? { payloads: pushInput.payloads } : {}),
      ...(pushInput.resetPolicy ? { resetPolicy: pushInput.resetPolicy } : {}),
      ...(pushInput.pushedByUserId ? { pushedByUserId: pushInput.pushedByUserId } : {}),
    });
    const result = await executeCandidateBatch(
      batch,
      branchMap(drafted.map((source) => source.branch)),
      lease,
      leasedBranchIds,
      pushInput.signal,
    ).catch((cause: unknown) => {
      if (cause instanceof StagedBatchResume) cause.answer = { order, unbatched };
      throw cause;
    });
    // The retry rereads every branch; the pushed one then reports already_pushed.
    if (result.kind === "conflict") {
      throw new BranchPushCommitConflictError(result.push.branchId ?? "");
    }
    return itemsOf(order, unbatched, result);
  }

  /** Settles the batch this call staged and still owns, under the grown lease set (F22). */
  async function continueStaged(
    resume: StagedBatchResume,
    lease: BranchLockLease,
    leasedBranchIds: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<PushBranchesResult> {
    const { phases, resetPolicy } = resume.batch;
    const locked = await transition
      .continueStaged<BatchPipelineResult>({
        staged: resume.handoff.staged,
        leasedBranchIds,
        ...(signal ? { signal } : {}),
        finish: ({ outcome, docs }) => batchResult(outcome, docs, phases),
      })
      .catch((cause: unknown) => {
        if (cause instanceof PublicationLeasesChangedError) resume.handoff = cause;
        throw cause instanceof PublicationLeasesChangedError ? resume : cause;
      });
    const result = await withAutoResets(locked, lease, phases, resetPolicy);
    const answer = resume.answer ?? { order: [], unbatched: new Map() };
    return itemsOf(answer.order, answer.unbatched, result);
  }

  /**
   * Publishes several drafts as one batch. When completion needs leases this call doesn't
   * hold (a model write grew the draft it may close), the call keeps the batch it staged,
   * releases its leases, leases the grown set in global order and continues that batch:
   * the writer gets the real results, and the late item stays in the draft (F22).
   */
  const pushBranchesToLive: BranchPushService["pushBranchesToLive"] = async (pushInput) => {
    // The outer preparation: branches the publication steps declare from their payloads.
    let extraBranchIds = await input.settlementStore.prepareBranchLeases(
      new Map(Object.entries(pushInput.payloads ?? {})),
    );
    let resume: StagedBatchResume | null = null;
    for (let rediscovered = 0; ; rediscovered += 1) {
      try {
        const staged = resume;
        return await withActiveWorkDraftBranchLock(
          pushInput.branchIds,
          (branches, lease, leasedBranchIds) =>
            staged
              ? continueStaged(staged, lease, leasedBranchIds, pushInput.signal)
              : stageAndSettle(pushInput, branches, lease, leasedBranchIds),
          extraBranchIds,
        );
      } catch (cause) {
        if (!(cause instanceof StagedBatchResume)) throw cause;
        if (rediscovered >= MAX_LEASE_REDISCOVERIES) {
          // Hand it to recovery, which discovers its leases on its own.
          await input.settlementStore.recordFailure({
            batchId: cause.handoff.staged.batchId,
            claim: cause.handoff.staged.claim,
            error: "publication branch leases kept changing",
          });
          throw cause.handoff;
        }
        resume = cause;
        extraBranchIds = [...new Set([...extraBranchIds, ...cause.handoff.branchIds])].sort();
      }
    }
  };

  const pushToLive: BranchPushService["pushToLive"] = async (pushInput) => {
    const { items } = await pushBranchesToLive({ ...pushInput, branchIds: [pushInput.branchId] });
    return items[0] as PushToLiveResult;
  };

  return {
    pushToLive,
    pushBranchesToLive,
    recoverPendingLiveSettlements: transition.recover,
  };

  async function resolveDocumentTitle(documentId: DocumentId): Promise<string> {
    const resolved = (await input.resolveDocumentTitle?.(documentId))?.trim();
    return resolved || "Untitled document";
  }

  async function noActiveRows(branch: BranchSnapshot): Promise<NoActiveRows> {
    const existing = await input.journalReadStore.latestPushForBranch(
      branch.branchId,
      branch.generation,
    );
    return existing ? { kind: "existing", push: existing } : { kind: "noop", branch };
  }
}

type NoActiveRows =
  | { kind: "existing"; push: PushLineageRow }
  | { kind: "noop"; branch: BranchSnapshot };

function mapNoActiveRows(cause: NoActiveRows): PushToLiveResult {
  if (cause.kind === "existing") return { status: "already_pushed", push: cause.push };
  return {
    status: "noop",
    branchId: cause.branch.branchId,
    documentId: cause.branch.documentId,
    branchGeneration: cause.branch.generation,
    reason: "no_active_rows",
  };
}

function branchMap(branches: readonly BranchSnapshot[]): ReadonlyMap<string, BranchSnapshot> {
  return new Map(branches.map((branch) => [branch.branchId, branch]));
}

function assertActiveWorkDraftBranch(
  branch: BranchSnapshot | null | undefined,
  branchId: string,
): BranchSnapshot {
  if (!branch) throw new Error(`Branch ${branchId} does not exist`);
  if (branch.kind !== "work_draft" || branch.status !== "active") {
    throw new Error(`Branch ${branchId} is not an active work draft`);
  }
  return branch;
}

const maxCasRetries = 3;
/** How many times one call leases a grown set before handing its batch to recovery. */
const MAX_LEASE_REDISCOVERIES = 3;

/**
 * A staged batch the call still owns, carried out of its leases so it can lease the grown
 * set and continue: the transition's handoff, what the pipeline staged, and once known
 * the request's branch order and the branches left out of the batch.
 */
class StagedBatchResume extends Error {
  answer?: { order: readonly string[]; unbatched: ReadonlyMap<string, PushToLiveResult> };
  constructor(
    public handoff: PublicationLeasesChangedError,
    readonly batch: { phases: readonly ComputedCandidate[]; resetPolicy: "auto" | undefined },
  ) {
    super(handoff.message);
    this.name = "StagedBatchResume";
  }
}
