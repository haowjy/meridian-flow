/** One data-driven pipeline for durable branch pushes into live documents. */
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { type Attempt, NO_ATTEMPT_SCOPE, runBoundedAttempts } from "./branch-attempts.js";
import type { BranchJournalRow } from "./branch-journal.js";
import {
  buildSelectedRowCandidates,
  buildWholeBranchCandidates,
} from "./branch-push-candidates.js";
import {
  BranchPushCommitConflictError,
  BranchPushRetryExhaustedError,
  type BranchPushService,
  type BranchPushServiceInput,
  type CandidateBatch,
  DraftChangeRefusal,
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
import { createBranchPushTransition, type PublicationOutcome } from "./branch-push-transition.js";
import { type BranchSnapshot, materializeBranchRead } from "./branch-store.js";
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
  | { kind: "command_exists"; phases: readonly ComputedCandidate[] }
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
    };

export function createBranchPushService(input: BranchPushServiceInput): BranchPushService {
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
      if (candidate.materialization === "selected_rows") {
        afterDoc = createCollabYDoc({ gc: false });
        Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(liveDoc));
        for (const row of rows) Y.applyUpdate(afterDoc, row.updateData);
        assertNoPendingIntegration(
          afterDoc,
          "selective_content_push",
          rows.map((row) => row.id),
        );
        assertRowsIntegrated(afterDoc, rows, "selective_content_push");
        pushUpdate = Y.encodeStateAsUpdate(afterDoc, Y.encodeStateVector(liveDoc));
      } else {
        branchDoc = await materializeBranch(branch);
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
    attempt: Pick<Attempt, "commit"> | undefined,
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
    return transition.execute<BatchPipelineResult>({
      documentIds: phases.map((phase) => phase.candidate.documentId),
      signal,
      ...(attempt ? { attempt } : {}),
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
            ...(batch.expectedLiveRevision !== undefined
              ? { expectedLiveRevision: batch.expectedLiveRevision }
              : {}),
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
          ...(batch.command ? { command: batch.command } : {}),
          afterDurableCommit: input.hooks?.afterDurableCommit,
          onConflict: (push: PushLineageRow) => ({
            kind: "conflict" as const,
            push,
            phases,
          }),
          onCommandExists: () => ({ kind: "command_exists" as const, phases }),
          finish: ({ outcome }): BatchPipelineResult => batchResult(outcome, phases),
        };
      },
    });
  }

  /** A settled batch as the pipeline reports it, from the phases it staged. */
  function batchResult(
    outcome: PublicationOutcome,
    phases: readonly ComputedCandidate[],
  ): BatchPipelineResult {
    if (outcome.kind === "refused") return { kind: "refused", reason: outcome.reason, phases };
    if (outcome.kind === "command_exists") return { kind: "command_exists", phases };
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
    };
  }

  /**
   * Revalidates the drafts being pushed and runs the batch, inside the documents' link scope,
   * as bounded attempts: an attempt whose branch moved before or at staging (a writer typing)
   * rolls its staging back and runs again from a fresh read. A branchless publication
   * (payloads only) opens no document scope and stages once.
   */
  async function withActiveWorkDraftBranches<T>(
    branchIds: readonly string[],
    run: (branches: readonly BranchSnapshot[], attempt?: Attempt) => Promise<T>,
    refuseGone = false,
  ): Promise<T> {
    const retryBranchId = branchIds[0];
    if (!retryBranchId) return run([]);
    const readBranches = () =>
      Promise.all(
        branchIds.map(async (branchId) =>
          assertActiveWorkDraftBranch(
            await input.branchStore.getBranch(branchId),
            branchId,
            refuseGone,
          ),
        ),
      );
    const documentIds = (await readBranches()).map((branch) => branch.documentId);
    // The tree is independent of branch state: the scope opens before the first attempt.
    return input.links.within({ documentId: documentIds[0] as string, documentIds }, () =>
      runBoundedAttempts({
        bound: STAGING_ATTEMPTS,
        // Staging is root-owned (the settlement it stages must commit on its own).
        scope: NO_ATTEMPT_SCOPE,
        isMiss: (cause) => cause instanceof BranchPushCommitConflictError,
        run: async (attempt) => run(await readBranches(), attempt),
        exhausted: (cause) => {
          const conflict = cause as BranchPushCommitConflictError;
          throw new BranchPushRetryExhaustedError(
            conflict.branchId || retryBranchId,
            STAGING_ATTEMPTS - 1,
            conflict,
          );
        },
      }),
    );
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

  /**
   * The branch's content at the revision the attempt read. A newer revision is a moved
   * branch: the attempt recaptures, as a failed staging compare would make it.
   */
  async function materializeBranch(branch: BranchSnapshot): Promise<Y.Doc> {
    const read = await input.branchStore.readBranchAt(branch.branchId);
    if (read?.branch.revision !== branch.revision)
      throw new BranchPushCommitConflictError(branch.branchId);
    return materializeBranchRead(read);
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
        return [
          phase.branch.branchId,
          {
            status: "pushed" as const,
            push,
            update: phase.pushUpdate,
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
    if (result?.kind === "command_exists") {
      return { items: [], heldItems: [], outcomes: [], commandExists: true };
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
    attempt: Attempt | undefined,
  ): Promise<PushBranchesResult> {
    const sources = await Promise.all(branches.map(sourceFor));
    const order = sources.map((source) => source.branch.branchId);
    const [selectedSource] = pushInput.selected ? sources : [];
    const drafted = sources.filter((source) => source.rows.length > 0);
    const unbatched = new Map<string, PushToLiveResult>();
    for (const source of sources) {
      if (source.rows.length > 0) continue;
      unbatched.set(source.branch.branchId, mapNoActiveRows(await noActiveRows(source.branch)));
    }
    if (drafted.length === 0 && Object.keys(pushInput.payloads ?? {}).length === 0) {
      return itemsOf(order, unbatched, null);
    }
    // Per-change Apply selects its rows now, on this attempt's read (B3).
    const selection =
      pushInput.selected && selectedSource
        ? await pushInput.selected.select(selectedSource.branch, selectedSource.rows)
        : null;
    const batch =
      selection && selectedSource
        ? buildSelectedRowCandidates({
            source: selectedSource,
            journalIds: selection.journalIds,
            expectedLiveRevision: selection.expectedLiveRevision,
            payloads: selection.payloads,
            ...(pushInput.pushedByUserId ? { pushedByUserId: pushInput.pushedByUserId } : {}),
          })
        : buildWholeBranchCandidates({
            sources: drafted,
            ...(pushInput.payloads ? { payloads: pushInput.payloads } : {}),
            ...(pushInput.pushedByUserId ? { pushedByUserId: pushInput.pushedByUserId } : {}),
          });
    if (pushInput.command) batch.command = pushInput.command;
    const result = await executeCandidateBatch(
      batch,
      branchMap(drafted.map((source) => source.branch)),
      attempt,
      pushInput.signal,
    );
    // The retry rereads every branch; the pushed one then reports already_pushed.
    if (result.kind === "conflict" && !pushInput.selected) {
      throw new BranchPushCommitConflictError(result.push.branchId ?? "");
    }
    return itemsOf(order, unbatched, result);
  }

  /** Publishes several drafts as one batch. */
  const pushBranchesToLive: BranchPushService["pushBranchesToLive"] = (pushInput) =>
    withActiveWorkDraftBranches(
      pushInput.branchIds,
      (branches, attempt) => stageAndSettle(pushInput, branches, attempt),
      Boolean(pushInput.selected),
    );

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
  refuseGone = false,
): BranchSnapshot {
  if (refuseGone && (branch?.kind !== "work_draft" || branch.status !== "active")) {
    throw new DraftChangeRefusal("gone");
  }
  if (!branch) throw new Error(`Branch ${branchId} does not exist`);
  if (branch.kind !== "work_draft" || branch.status !== "active") {
    throw new Error(`Branch ${branchId} is not an active work draft`);
  }
  return branch;
}

/** A writer typing moves the branch; this many stagings each finding it moved answer stale. */
const STAGING_ATTEMPTS = 4;
