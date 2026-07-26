/** One data-driven pipeline for durable branch pushes into live documents. */
import { createAgentEditCodec } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import { type BranchLockLease, createBranchCriticalSections } from "./branch-critical-sections.js";
import { buildCompanionCandidates, buildWholeBranchCandidates } from "./branch-push-candidates.js";
import {
  type BranchJournalRow,
  BranchPushCommitConflictError,
  BranchPushRetryExhaustedError,
  type BranchPushService,
  type BranchPushServiceInput,
  type CandidateBatch,
  type PendingLiveSettlement,
  type PushCandidate,
  type PushLineageRow,
  type PushToLiveResult,
} from "./branch-push-contracts.js";
import {
  assertNoPendingIntegration,
  assertRowsIntegrated,
  stablePushIdempotencyKey,
  wholeBranchPushUpdate,
} from "./branch-push-plan.js";
import { preparePushUnderLiveLock } from "./branch-push-preparation.js";
import { createBranchPushTransition } from "./branch-push-transition.js";
import { buildDurablePushTrail } from "./branch-trail-projection.js";
import type { DurableTrailRecord } from "./ports/change-trail-persistence.js";
import { createWorkDraftPending } from "./work-draft-pending.js";
import { createWorkPushPolicy } from "./work-push-policy.js";

type ComputedCandidate = {
  candidate: PushCandidate;
  branch: BranchSnapshot;
  pushUpdate: Uint8Array;
  idempotencyKey: string;
};

type BatchPipelineResult =
  | { kind: "conflict"; push: PushLineageRow; phases: readonly ComputedCandidate[] }
  | {
      kind: "committed";
      pushes: readonly PushLineageRow[];
      phases: readonly ComputedCandidate[];
      liveAfterPush: ReadonlyMap<DocumentId, Uint8Array>;
      branchReset?: { branchId: string; fromGeneration: number };
    };

export function createBranchPushService(input: BranchPushServiceInput): BranchPushService {
  const criticalSections = input.criticalSections ?? createBranchCriticalSections();
  const computePushUpdate = input.pushUpdateComputer ?? wholeBranchPushUpdate;
  const attributionCodec = createAgentEditCodec(input.codec);
  const transition = createBranchPushTransition({
    commitStore: input.commitStore,
    settlementStore: input.settlementStore,
    liveCoordinator: input.liveCoordinator,
    model: input.model,
    codec: attributionCodec,
    changeEventDelivery: input.changeEventDelivery,
    writerIngressBarrier: input.writerIngressBarrier,
    sweepProjectionDiagnostics: input.sweepProjectionDiagnostics,
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
    let afterDoc: Y.Doc | null = null;
    let branchDoc: Y.Doc | null = null;
    try {
      let pushUpdate: Uint8Array;
      if (candidate.kind === "manifest") {
        const operation = "manifest_membership_push";
        afterDoc = createCollabYDoc({ gc: false });
        Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(liveDoc));
        for (const row of rows) Y.applyUpdate(afterDoc, row.updateData);
        assertNoPendingIntegration(
          afterDoc,
          operation,
          rows.map((row) => row.id),
        );
        assertRowsIntegrated(afterDoc, rows, operation);
        pushUpdate = Y.encodeStateAsUpdate(afterDoc, Y.encodeStateVector(liveDoc));
      } else {
        branchDoc = materializeBranch(branch);
        pushUpdate = computePushUpdate({ branch, branchDoc, liveDoc });
      }
      return {
        candidate,
        branch,
        pushUpdate,
        idempotencyKey: stablePushIdempotencyKey({
          branchId: branch.branchId,
          generation: branch.generation,
          journalIds: rows.map((row) => row.id),
          publicationKind: candidate.kind,
        }),
      };
    } finally {
      branchDoc?.destroy();
      afterDoc?.destroy();
      liveDoc.destroy();
    }
  }

  const prepareCandidate = (
    phase: ComputedCandidate,
    lockCutUpdate: Uint8Array,
    receiptId: string,
  ) =>
    preparePushUnderLiveLock(
      { model: input.model, attributionCodec },
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

  function pendingLiveSettlement(
    prepared: Awaited<ReturnType<typeof prepareCandidate>>,
    documentTitle: string,
    trail: DurableTrailRecord,
  ): Omit<PendingLiveSettlement, "push"> {
    return transition.prepare({
      documentTitle,
      sweepEvidence: null,
      lockCutUpdate: prepared.lockCutUpdate,
      pushUpdate: prepared.prepared.pushUpdate,
      trail,
    });
  }

  async function executeCandidateBatch(
    batch: CandidateBatch,
    branches: ReadonlyMap<string, BranchSnapshot>,
    lease: BranchLockLease,
    signal?: AbortSignal,
  ): Promise<BatchPipelineResult> {
    if (batch.candidates.length === 0) throw new Error("Candidate batch requires a push");
    const phases = await Promise.all(
      batch.candidates.map((candidate) => {
        const branch = branches.get(candidate.branchId);
        if (!branch) throw new Error(`Candidate branch ${candidate.branchId} was not locked`);
        return computeCandidate(candidate, branch);
      }),
    );
    const locked = await transition.execute<BatchPipelineResult>({
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
            pendingLiveSettlement: pendingLiveSettlement(candidate, documentTitle, trail),
            branch: phase.branch,
          };
        });
        return {
          kind: "push" as const,
          pushes,
          afterDurableCommit: input.hooks?.afterDurableCommit,
          onConflict: (push: PushLineageRow) => ({
            kind: "conflict" as const,
            push,
            phases,
          }),
          finish: ({ pushes: committed, docs }) => ({
            kind: "committed" as const,
            pushes: committed,
            phases,
            liveAfterPush: new Map(
              phases.map((phase) => [
                phase.candidate.documentId,
                Y.encodeStateAsUpdate(docs.get(phase.candidate.documentId) as Y.Doc),
              ]),
            ),
          }),
        };
      },
    });
    if (locked.kind !== "committed") return locked;
    const primary = phases[0] as ComputedCandidate;
    const branchReset =
      batch.resetPolicy === "auto"
        ? await resetAutoBranchIfDrained(
            lease,
            primary.branch,
            locked.liveAfterPush.get(primary.candidate.documentId) as Uint8Array,
          )
        : undefined;
    return {
      kind: "committed",
      pushes: locked.pushes,
      phases,
      liveAfterPush: locked.liveAfterPush,
      ...(branchReset ? { branchReset } : {}),
    };
  }

  async function withActiveWorkDraftBranchLock<T>(
    branchIds: readonly string[],
    run: (branches: readonly BranchSnapshot[], lease: BranchLockLease) => Promise<T>,
  ): Promise<T> {
    const retryBranchId = branchIds[0];
    if (!retryBranchId) throw new Error("active work draft lock requires at least one branch");
    for (let attempt = 0; attempt <= maxCasRetries; attempt += 1) {
      try {
        return await criticalSections.withBranches(branchIds, async (lease) => {
          const branches = await Promise.all(
            branchIds.map(async (branchId) =>
              assertActiveWorkDraftBranch(await input.branchStore.getBranch(branchId), branchId),
            ),
          );
          return run(branches, lease);
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

  function mapCommitted(result: Extract<BatchPipelineResult, { kind: "committed" }>) {
    const phase = result.phases[0] as ComputedCandidate;
    return {
      status: "pushed" as const,
      push: result.pushes[0] as PushLineageRow,
      update: phase.pushUpdate,
      ...(result.branchReset ? { branchReset: result.branchReset } : {}),
    };
  }

  const pushToLive: BranchPushService["pushToLive"] = (pushInput) =>
    withActiveWorkDraftBranchLock([pushInput.branchId], async ([branch], lease) => {
      const source = await sourceFor(branch as BranchSnapshot);
      if (source.rows.length === 0) return mapNoActiveRows(await noActiveRows(source.branch));
      const batch = buildWholeBranchCandidates({
        source,
        ...((pushInput.resetPolicy ?? source.branch.pushPolicy) === "auto"
          ? { resetPolicy: "auto" as const }
          : {}),
        ...(pushInput.pushedByUserId ? { pushedByUserId: pushInput.pushedByUserId } : {}),
      });
      const result = await executeCandidateBatch(
        batch,
        branchMap([source.branch]),
        lease,
        pushInput.signal,
      );
      if (result.kind === "conflict") {
        return { status: "already_pushed", push: result.push };
      }
      return mapCommitted(result);
    });

  const pushToLiveWithManifestEntry: BranchPushService["pushToLiveWithManifestEntry"] = (
    pushInput,
  ) =>
    withActiveWorkDraftBranchLock(
      [pushInput.branchId, pushInput.manifestBranchId],
      async ([contentBranch, manifestBranch], lease) => {
        const content = await sourceFor(contentBranch as BranchSnapshot);
        if (content.rows.length === 0) return mapNoActiveRows(await noActiveRows(content.branch));
        const manifest = await sourceFor(manifestBranch as BranchSnapshot);
        const built = buildCompanionCandidates({
          content,
          manifest,
          manifestEntryDocumentId: pushInput.manifestEntryDocumentId,
          ...(pushInput.pushedByUserId ? { pushedByUserId: pushInput.pushedByUserId } : {}),
          ...(pushInput.resetPolicy ? { resetPolicy: pushInput.resetPolicy } : {}),
        });
        const result = await executeCandidateBatch(
          built,
          branchMap([content.branch, manifest.branch]),
          lease,
          pushInput.signal,
        );
        if (result.kind === "conflict") {
          throw new BranchPushCommitConflictError(content.branch.branchId);
        }
        return mapCommitted(result);
      },
    );

  const workPushPolicy = createWorkPushPolicy({
    branchStore: input.branchStore,
    workPushPolicyStore: input.workPushPolicyStore,
    workDraftPending: createWorkDraftPending(input.workDraftPendingStore),
    pushToLive,
    applyPendingDraft: ({ draft, pushedByUserId }) =>
      draft.manifestEntry
        ? pushToLiveWithManifestEntry({
            branchId: draft.branch.branchId,
            manifestBranchId: draft.manifestEntry.branchId,
            manifestEntryDocumentId: draft.manifestEntry.documentId,
            ...(pushedByUserId ? { pushedByUserId } : {}),
            resetPolicy: "auto",
          })
        : pushToLive({
            branchId: draft.branch.branchId,
            ...(pushedByUserId ? { pushedByUserId } : {}),
            resetPolicy: "auto",
          }),
  });

  return {
    pushToLive,
    pushToLiveWithManifestEntry,
    recoverPendingLiveSettlements: transition.recover,
    ...workPushPolicy,
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
