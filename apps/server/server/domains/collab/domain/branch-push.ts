/** One data-driven pipeline for durable branch pushes into live documents. */
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { buildSelectedRowCandidates, buildWholeDraftCandidates } from "./branch-push-candidates.js";
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
  wholeDraftPushUpdate,
} from "./branch-push-plan.js";
import { preparePushUnderLiveLock } from "./branch-push-preparation.js";
import { type ApplyOutcome, createBranchPushTransition } from "./branch-push-transition.js";
import { type Attempt, NO_ATTEMPT_SCOPE, runBoundedAttempts } from "./draft-attempts.js";
import type { DraftJournalRow } from "./draft-journal.js";
import { type DraftSnapshot, materializeDraftRead } from "./draft-store.js";
import { buildDurablePushTrail } from "./draft-trail-projection.js";
import type { ApplyItemHold, ApplyItemOutcome, ApplyRefusal } from "./ports/settlement-apply.js";

type ComputedCandidate = {
  candidate: PushCandidate;
  documentDraft: DraftSnapshot;
  pushUpdate: Uint8Array;
  idempotencyKey: string;
};

type BatchPipelineResult =
  | { kind: "conflict"; push: PushLineageRow; phases: readonly ComputedCandidate[] }
  | { kind: "command_exists"; phases: readonly ComputedCandidate[] }
  | { kind: "refused"; reason: ApplyRefusal; phases: readonly ComputedCandidate[] }
  | {
      kind: "committed";
      /** The pushes whose text reached live. */
      pushes: readonly PushLineageRow[];
      /** Candidates an Apply step kept out of live, and why. */
      held: ReadonlyMap<DocumentId, ApplyRefusal>;
      /** Every held item, items without text drafts included. */
      heldItems: readonly ApplyItemHold[];
      /** What the steps did per applied item, decided in completion. */
      outcomes: readonly ApplyItemOutcome[];
      phases: readonly ComputedCandidate[];
    };

export function createBranchPushService(input: BranchPushServiceInput): BranchPushService {
  const computePushUpdate = input.pushUpdateComputer ?? wholeDraftPushUpdate;
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
    draftId: string,
    generation: number,
  ): Promise<DraftJournalRow[]> {
    return input.journalReadStore.listReviewableJournalRows(draftId, generation);
  }

  async function computeCandidate(
    candidate: PushCandidate,
    documentDraft: DraftSnapshot,
  ): Promise<ComputedCandidate> {
    const rows = candidate.rows;
    const liveDoc = await loadLiveDoc(documentDraft.documentId);
    let afterDoc: Y.Doc | null = null;
    let draftDoc: Y.Doc | null = null;
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
        draftDoc = await materializeDraft(documentDraft);
        pushUpdate = computePushUpdate({ documentDraft, draftDoc, liveDoc });
      }
      return {
        candidate,
        documentDraft,
        pushUpdate,
        idempotencyKey: stablePushIdempotencyKey({
          draftId: documentDraft.draftId,
          generation: documentDraft.generation,
          journalIds: rows.map((row) => row.id),
        }),
      };
    } finally {
      draftDoc?.destroy();
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
        documentDraft: phase.documentDraft,
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
    drafts: ReadonlyMap<string, DraftSnapshot>,
    attempt: Pick<Attempt, "commit"> | undefined,
    signal?: AbortSignal,
  ): Promise<BatchPipelineResult> {
    if (batch.candidates.length === 0 && Object.keys(batch.payloads ?? {}).length === 0) {
      throw new Error("Candidate batch requires a push or an Apply payload");
    }
    const phases = await Promise.all(
      batch.candidates.map((candidate) => {
        const documentDraft = drafts.get(candidate.draftId);
        if (!documentDraft) throw new Error(`Candidate draft ${candidate.draftId} was not locked`);
        return computeCandidate(candidate, documentDraft);
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
            documentDraft: phase.documentDraft,
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
    outcome: ApplyOutcome,
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
   * as bounded attempts: an attempt whose draft moved before or at staging (a writer typing)
   * rolls its staging back and runs again from a fresh read. An Apply
   * with no text drafts (payloads only) opens no document scope and stages once.
   */
  async function withActiveWorkDrafts<T>(
    draftIds: readonly string[],
    run: (drafts: readonly DraftSnapshot[], attempt?: Attempt) => Promise<T>,
    refuseGone = false,
  ): Promise<T> {
    const retryDraftId = draftIds[0];
    if (!retryDraftId) return run([]);
    const readDrafts = () =>
      Promise.all(
        draftIds.map(async (draftId) =>
          assertActiveWorkDraft(await input.draftStore.getDraft(draftId), draftId, refuseGone),
        ),
      );
    const documentIds = (await readDrafts()).map((documentDraft) => documentDraft.documentId);
    // The tree is independent of draft state: the scope opens before the first attempt.
    return input.links.within({ documentId: documentIds[0] as string, documentIds }, () =>
      runBoundedAttempts({
        bound: STAGING_ATTEMPTS,
        // Staging is root-owned (the settlement it stages must commit on its own).
        scope: NO_ATTEMPT_SCOPE,
        isMiss: (cause) => cause instanceof BranchPushCommitConflictError,
        run: async (attempt) => run(await readDrafts(), attempt),
        exhausted: (cause) => {
          const conflict = cause as BranchPushCommitConflictError;
          throw new BranchPushRetryExhaustedError(
            conflict.draftId || retryDraftId,
            STAGING_ATTEMPTS - 1,
            conflict,
          );
        },
      }),
    );
  }

  async function sourceFor(documentDraft: DraftSnapshot): Promise<{
    documentDraft: DraftSnapshot;
    rows: DraftJournalRow[];
  }> {
    return {
      documentDraft,
      rows: await listReviewableRows(documentDraft.draftId, documentDraft.generation),
    };
  }

  /**
   * The draft's content at the revision the attempt read. A newer revision is a moved
   * draft: the attempt recaptures, as a failed staging compare would make it.
   */
  async function materializeDraft(documentDraft: DraftSnapshot): Promise<Y.Doc> {
    const read = await input.draftStore.readDraftAt(documentDraft.draftId);
    if (read?.documentDraft.revision !== documentDraft.revision)
      throw new BranchPushCommitConflictError(documentDraft.draftId);
    return materializeDraftRead(read);
  }

  /** One item per pushed candidate, keyed by its draft. */
  function mapCommitted(
    result: Extract<BatchPipelineResult, { kind: "committed" }>,
  ): ReadonlyMap<string, PushToLiveResult> {
    return new Map(
      result.phases.map((phase): [string, PushToLiveResult] => {
        const heldReason = result.held.get(phase.candidate.documentId);
        if (heldReason) {
          return [
            phase.documentDraft.draftId,
            {
              status: "held" as const,
              draftId: phase.documentDraft.draftId,
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
          phase.documentDraft.draftId,
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
      draftId: phase.documentDraft.draftId,
      documentId: phase.candidate.documentId,
      reason: result.reason,
    }));
  }

  type PushDraftsInput = Parameters<BranchPushService["pushDraftsToLive"]>[0];
  type PushDraftsResult = Awaited<ReturnType<BranchPushService["pushDraftsToLive"]>>;

  /** The per-draft answer in request order, from a batch's result and the drafts it left out. */
  function itemsOf(
    order: readonly string[],
    unbatched: ReadonlyMap<string, PushToLiveResult>,
    result: BatchPipelineResult | null,
  ): PushDraftsResult {
    const items = new Map(unbatched);
    let refused: ApplyRefusal | undefined;
    if (result?.kind === "refused") {
      refused = result.reason;
      for (const item of mapRefused(result)) items.set(item.draftId, item);
    } else if (result?.kind === "committed") {
      for (const [draftId, item] of mapCommitted(result)) items.set(draftId, item);
    }
    if (result?.kind === "command_exists") {
      return { items: [], heldItems: [], outcomes: [], commandExists: true };
    }
    return {
      items: order.map((draftId) => items.get(draftId) as PushToLiveResult),
      heldItems: result?.kind === "committed" ? result.heldItems : [],
      outcomes: result?.kind === "committed" ? result.outcomes : [],
      ...(refused ? { refused } : {}),
    };
  }

  /** Stages the drafts with rows and the payloads as one batch, then settles it. */
  async function stageAndSettle(
    pushInput: PushDraftsInput,
    drafts: readonly DraftSnapshot[],
    attempt: Attempt | undefined,
  ): Promise<PushDraftsResult> {
    const sources = await Promise.all(drafts.map(sourceFor));
    const order = sources.map((source) => source.documentDraft.draftId);
    const [selectedSource] = pushInput.selected ? sources : [];
    const drafted = sources.filter((source) => source.rows.length > 0);
    const unbatched = new Map<string, PushToLiveResult>();
    for (const source of sources) {
      if (source.rows.length > 0) continue;
      unbatched.set(
        source.documentDraft.draftId,
        mapNoActiveRows(await noActiveRows(source.documentDraft)),
      );
    }
    if (drafted.length === 0 && Object.keys(pushInput.payloads ?? {}).length === 0) {
      return itemsOf(order, unbatched, null);
    }
    // Per-change Apply selects its rows now, on this attempt's read (B3).
    const selection =
      pushInput.selected && selectedSource
        ? await pushInput.selected.select(selectedSource.documentDraft, selectedSource.rows)
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
        : buildWholeDraftCandidates({
            sources: drafted,
            ...(pushInput.payloads ? { payloads: pushInput.payloads } : {}),
            ...(pushInput.pushedByUserId ? { pushedByUserId: pushInput.pushedByUserId } : {}),
          });
    if (pushInput.command) batch.command = pushInput.command;
    const result = await executeCandidateBatch(
      batch,
      draftMap(drafted.map((source) => source.documentDraft)),
      attempt,
      pushInput.signal,
    );
    // The retry rereads every draft; the pushed one then reports already_pushed.
    if (result.kind === "conflict" && !pushInput.selected) {
      throw new BranchPushCommitConflictError(result.push.draftId ?? "");
    }
    return itemsOf(order, unbatched, result);
  }

  /** Applies several drafts as one batch. */
  const pushDraftsToLive: BranchPushService["pushDraftsToLive"] = (pushInput) =>
    withActiveWorkDrafts(
      pushInput.draftIds,
      (drafts, attempt) => stageAndSettle(pushInput, drafts, attempt),
      Boolean(pushInput.selected),
    );

  const pushToLive: BranchPushService["pushToLive"] = async (pushInput) => {
    const { items } = await pushDraftsToLive({ ...pushInput, draftIds: [pushInput.draftId] });
    return items[0] as PushToLiveResult;
  };

  return {
    pushToLive,
    pushDraftsToLive,
    recoverPendingLiveSettlements: transition.recover,
  };

  async function resolveDocumentTitle(documentId: DocumentId): Promise<string> {
    const resolved = (await input.resolveDocumentTitle?.(documentId))?.trim();
    return resolved || "Untitled document";
  }

  async function noActiveRows(documentDraft: DraftSnapshot): Promise<NoActiveRows> {
    const existing = await input.journalReadStore.latestPushForDraft(
      documentDraft.draftId,
      documentDraft.generation,
    );
    return existing ? { kind: "existing", push: existing } : { kind: "noop", documentDraft };
  }
}

type NoActiveRows =
  | { kind: "existing"; push: PushLineageRow }
  | { kind: "noop"; documentDraft: DraftSnapshot };

function mapNoActiveRows(cause: NoActiveRows): PushToLiveResult {
  if (cause.kind === "existing") return { status: "already_pushed", push: cause.push };
  return {
    status: "noop",
    draftId: cause.documentDraft.draftId,
    documentId: cause.documentDraft.documentId,
    draftGeneration: cause.documentDraft.generation,
    reason: "no_active_rows",
  };
}

function draftMap(drafts: readonly DraftSnapshot[]): ReadonlyMap<string, DraftSnapshot> {
  return new Map(drafts.map((documentDraft) => [documentDraft.draftId, documentDraft]));
}

function assertActiveWorkDraft(
  documentDraft: DraftSnapshot | null | undefined,
  draftId: string,
  refuseGone = false,
): DraftSnapshot {
  if (refuseGone && (documentDraft?.kind !== "work_draft" || documentDraft.status !== "active")) {
    throw new DraftChangeRefusal("gone");
  }
  if (!documentDraft) throw new Error(`Draft ${draftId} does not exist`);
  if (documentDraft.kind !== "work_draft" || documentDraft.status !== "active") {
    throw new Error(`Draft ${draftId} is not an active work draft`);
  }
  return documentDraft;
}

/** A writer typing moves the draft; this many stagings each finding it moved answer stale. */
const STAGING_ATTEMPTS = 4;
