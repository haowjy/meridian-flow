/** Durable-first work-draft to live push service for branch peers. */
import { randomUUID } from "node:crypto";
import {
  createAgentEditCodec,
  type DocumentCoordinator,
  diffSnapshots,
  digestRenderedContent,
  lineageCovered,
  type ObservationEntry,
  type ObservationSnapshotStore,
  observationCoversRendering,
  parseSealedWriterLineageV3,
  type ResponseCausalCutV1,
  type SettlementLineageEvidenceV2,
  snapshotBlocks,
  toDocHandle,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
import type { DraftApplyConflict } from "@meridian/contracts";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { MarkupCodec } from "@meridian/markup";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { NoticeInput, NoticePort } from "../../notices/index.js";
import type { BranchCoordinator, BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import {
  type BranchCriticalSections,
  type BranchLockLease,
  createBranchCriticalSections,
} from "./branch-critical-sections.js";
import {
  assertNoPendingIntegration,
  assertRowsIntegrated,
  buildReceipt,
  conflictEchoFrom,
  markdownFromDoc,
  stablePushIdempotencyKey,
  wholeBranchPushUpdate,
} from "./branch-push-plan.js";
import { createBranchPushTransition } from "./branch-push-transition.js";
import { createBranchReviewOperations } from "./branch-review-operations.js";
import {
  journalAttributionByChangedBlock,
  preparedTrailChanges,
} from "./branch-trail-projection.js";
import { partitionByBlockCoverage } from "./branch-update-attribution.js";
import type { DurableTrailRecord } from "./ports/change-trail-persistence.js";
import type { WriterIngressBarrier } from "./ports/writer-ingress-barrier.js";
import type { ProvenanceRun } from "./provenance.js";
import type { NavigationTargetV1, RawTrailChange } from "./trail-read-kernel.js";
import { createWorkPushPolicy } from "./work-push-policy.js";

export type { BranchJournalRow } from "./branch-push-contracts.js";

import type { BranchJournalRow } from "./branch-push-contracts.js";

export type ReceiptBlockChange = {
  blockId: string;
  beforeText: string | null;
  afterText: string | null;
  beforeWordCount: number;
  afterWordCount: number;
  wordDelta: number;
};

export type PushReceiptPayload = {
  version: 1;
  documentId: DocumentId;
  branchId: string;
  branchGeneration: number;
  pushKind: "whole" | "selective";
  changedBlocks: ReceiptBlockChange[];
  totalWordDelta: number;
};

export type PushLineageRow = {
  id: number;
  branchId: string | null;
  documentId: DocumentId;
  pushKind: "whole" | "selective";
  journalIds: number[];
  upstreamUpdateSeq: number | null;
  receiptPayload: PushReceiptPayload | null;
  idempotencyKey: string;
  receiptId?: string | null;
  threadId?: ThreadId | null;
  turnId?: TurnId | null;
};

export type BranchPushConflictEcho = {
  overlappingBlockIds: string[];
  current: Array<
    Pick<BranchJournalRow, "id" | "branchId" | "source" | "threadId" | "turnId" | "wId">
  >;
  concurrentPushes: Array<
    Pick<PushLineageRow, "id" | "branchId" | "threadId" | "turnId" | "journalIds">
  >;
};

export type PushToLiveResult =
  | {
      status: "pushed";
      push: PushLineageRow;
      update: Uint8Array;
      branchReset?: { branchId: string; fromGeneration: number };
      conflictEcho?: BranchPushConflictEcho;
      swept?: PushSweptTrail;
    }
  | { status: "already_pushed"; push: PushLineageRow; conflictEcho?: BranchPushConflictEcho }
  | {
      status: "push_concurrent_conflict";
      reason: "draft_base_divergence";
      conflictedBlocks: string[];
      conflicts: DraftApplyConflict[];
    }
  | {
      status: "noop";
      branchId: string;
      documentId: DocumentId;
      branchGeneration: number;
      reason: "no_active_rows";
    };

export type PreparedPushCommit = {
  branch: BranchSnapshot;
  journalRows: BranchJournalRow[];
  pushUpdate: Uint8Array;
  receiptPayload: PushReceiptPayload;
  idempotencyKey: string;
  receiptId?: string;
  markdownProjection: string;
  liveStateVector: Uint8Array;
  liveState: Uint8Array;
  pushedByUserId?: UserId;
  /** Required participant in the atomic branch-push commit bundle. */
  trail: DurableTrailRecord;
  /** Crash-recoverable handoff guarding the post-commit LOCK-WS window. */
  pendingLiveSettlement: Omit<PendingLiveSettlement, "push">;
};

export type PendingLiveSettlement = {
  push: PushLineageRow;
  documentTitle: string;
  lockCutUpdate: Uint8Array;
  pushUpdate: Uint8Array;
  postCutUpdates: readonly Uint8Array[];
  beforeContentRef: number | null;
  trail: DurableTrailRecord;
  provenanceView: readonly ProvenanceRun[];
  lineageEvidence: SettlementLineageEvidenceV2;
  responseEvidence: readonly SettlementResponseEvidence[];
  joinVersion: number;
  settledJoinVersion: number | null;
  claim: SettlementClaim;
  attemptCount: number;
  state: "pending";
};

export type SettlementResponseEvidence = {
  evidenceId: string;
  responseCut: ResponseCausalCutV1;
  visibleAtCut: readonly ProvenanceRun[];
  observations: readonly ObservationEntry[];
};

export type SettlementClaim = {
  token: string;
  epoch: number;
  kind: "warm" | "recovery";
  leaseExpiresAt: Date;
};

export type CompletionFenceResult = "applied" | "already_applied" | "retry";

export type PreparedDiscardCommit = {
  branch: BranchSnapshot;
  journalRows: BranchJournalRow[];
  state: Uint8Array;
  stateVector: Uint8Array;
  replacementUpdateData?: Uint8Array;
  replacementUpdateDataByJournalId?: ReadonlyMap<number, Uint8Array>;
  reviewedByUserId?: UserId;
};

export type BranchPushStore = {
  listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
  listReviewableJournalRows?(branchId: string, generation: number): Promise<BranchJournalRow[]>;
  listConcurrentJournalRows(
    branchId: string,
    generation: number,
    options: { afterJournalId?: number; documentId: DocumentId },
  ): Promise<BranchJournalRow[]>;
  latestPushForBranch?(branchId: string, generation: number): Promise<PushLineageRow | null>;
  listPushesForDocument?(documentId: DocumentId): Promise<PushLineageRow[]>;
  commitPush(
    input: PreparedPushCommit,
  ): Promise<
    | { status: "inserted"; push: PushLineageRow; settlement?: PendingLiveSettlement }
    | { status: "conflict"; push: PushLineageRow }
  >;
  commitDiscard?(input: PreparedDiscardCommit): Promise<void>;
  commitPushBatch?(input: { pushes: PreparedPushCommit[] }): Promise<{
    pushes: PushLineageRow[];
    settlements?: PendingLiveSettlement[];
  }>;
  /** Adds a frozen post-commit cut through the same trail aggregate/outbox. */
  settlePushTrail?(input: {
    push: PushLineageRow;
    trail?: DurableTrailRecord;
    refineToEmpty?: boolean;
    claim: SettlementClaim;
    joinVersion: number;
  }): Promise<boolean | undefined>;
  listRecoverableSettlementIds?(): Promise<number[]>;
  loadLiveSettlement?(pushId: number): Promise<PendingLiveSettlement>;
  withCompletionFence?(
    input: {
      pushId: number;
      documentId: DocumentId;
      claim: SettlementClaim;
      settledJoinVersion: number;
    },
    complete: () => CompletionFenceResult,
  ): Promise<CompletionFenceResult>;
  renewSettlementClaim?(input: {
    pushId: number;
    claim: SettlementClaim;
  }): Promise<SettlementClaim | null>;
  handoffSettlementClaim?(input: { pushId: number; claim: SettlementClaim }): Promise<boolean>;
  claimRecoverable?(input: {
    pushId: number;
    token: string;
  }): Promise<PendingLiveSettlement | null>;
  recordLiveSettlementFailure?(input: {
    pushId: number;
    claim: SettlementClaim;
    error: string;
  }): Promise<boolean>;
  blockLiveSettlement?(input: {
    pushId: number;
    claim: SettlementClaim;
    code: string;
    error: string;
  }): Promise<boolean>;
  countUnpushedRowsForWork(workId: WorkId): Promise<number>;
  listActiveWorkDraftBranchIdsForWork(workId: WorkId): Promise<string[]>;
  updateWorkDraftPushPolicy(workId: WorkId, policy: "manual" | "auto"): Promise<void>;
  listJournalRowsForTurn?(input: {
    branchId?: string;
    generation?: number;
    threadId: ThreadId;
    turnId: TurnId;
    statuses?: readonly BranchJournalRow["status"][];
  }): Promise<BranchJournalRow[]>;
  listJournalRowsForBranch?(input: {
    branchId: string;
    generation: number;
    throughJournalId?: number;
  }): Promise<BranchJournalRow[]>;
  listPushLineageForTurn?(input: { threadId: ThreadId; turnId: TurnId }): Promise<PushLineageRow[]>;
  commitTurnRedo?(input: PreparedDiscardCommit): Promise<void>;
  markRollbackPending(input: {
    branchId: string;
    generation: number;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<number>;
};

export type PushUpdateComputer = (input: {
  branch: BranchSnapshot;
  branchDoc: Y.Doc;
  liveDoc: Y.Doc;
}) => Uint8Array;

export type AutoPushAfterThreadPeerWriteInput = {
  workDraftBranchId: string;
  pushedByUserId?: UserId;
};

export type AutoPushAfterThreadPeerWriteResult =
  | PushToLiveResult
  | { status: "skipped"; reason: "manual_policy" | "not_active_work_draft" };

export type BranchPushService = {
  recoverPendingLiveSettlements(input?: { signal?: AbortSignal }): Promise<number>;
  pushToLive(input: {
    branchId: string;
    pushedByUserId?: UserId;
    signal?: AbortSignal;
    overlapPolicy?: "refuse" | "apply_and_trail";
  }): Promise<PushToLiveResult>;
  pushSelectedToLive(input: {
    branchId: string;
    journalIds: readonly number[];
    pushedByUserId?: UserId;
    signal?: AbortSignal;
  }): Promise<PushToLiveResult>;
  discardSelected(input: {
    branchId: string;
    journalIds: readonly number[];
    reviewedByUserId?: UserId;
  }): Promise<
    | { status: "discarded"; branchId: string; journalIds: number[] }
    | { status: "nothing_to_undo"; branchId: string; journalIds: number[] }
  >;
  reverseBranchTurn(input: {
    branchId: string;
    threadId: ThreadId;
    turnId: TurnId;
    direction: "undo" | "redo";
    reviewedByUserId?: UserId;
  }): Promise<
    | { status: "reversed" | "reconciled"; branchId: string; journalIds: number[] }
    | {
        status: "cant_undo_dependent" | "nothing_to_undo" | "nothing_to_redo";
        branchId: string;
        journalIds: number[];
      }
  >;
  pushToLiveWithManifestEntry(input: {
    branchId: string;
    manifestBranchId: string;
    manifestEntryDocumentId: DocumentId;
    contentJournalIds?: readonly number[];
    pushedByUserId?: UserId;
    signal?: AbortSignal;
    overlapPolicy?: "refuse" | "apply_and_trail";
  }): Promise<PushToLiveResult>;
  pushAutoBranchAfterThreadPeerWrite(
    input: AutoPushAfterThreadPeerWriteInput,
  ): Promise<AutoPushAfterThreadPeerWriteResult>;
  setWorkPushPolicy(input: {
    workId: WorkId;
    policy: "manual" | "auto";
    confirmedPush?: boolean;
    pushedByUserId?: UserId;
  }): Promise<
    | { status: "updated"; policy: "manual" | "auto" }
    | { status: "confirmation_required"; unpushedCount: number; reason: string }
  >;
  markFailedResponseRollbackPending(input: {
    branchId: string;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<
    | { status: "discarded"; branchId: string; journalIds: number[] }
    | { status: "rollback_pending"; rowsMarked: number }
  >;
};

export interface PushSweptTrail {
  affectedBlockHashes: readonly string[];
  capturedDeletedBodies: readonly { hash: string; body: string | "body_unavailable" }[];
  beforeContentRef: number | null;
  receiptId: string;
  locations: readonly {
    changeId: string;
    affectedBlockHash: string;
    outcome: "modify" | "delete";
    navigation: NavigationTargetV1;
  }[];
  reversible: boolean;
}

export type BranchPushExecutorInput = {
  branchStore: BranchStore;
  pushStore: BranchPushStore;
  branchCoordinator?: Pick<BranchCoordinator, "resetFromDocIfUnchangedWithLease"> &
    Partial<Pick<BranchCoordinator, "broadcastUpdate">>;
  journal: UpdateJournal & {
    readForReconstruction?: UpdateJournal["read"];
  };
  liveCoordinator: DocumentCoordinator;
  model: YProsemirrorDocumentModel;
  codec: MarkupCodec;
  pushUpdateComputer?: PushUpdateComputer;
  criticalSections?: BranchCriticalSections;
  resolveDocumentTitle?: (documentId: DocumentId) => Promise<string | null>;
  notices?: NoticePort;
  /** Sealed authoring-response evidence used only to attribute automatic push reports. */
  observations?: ObservationSnapshotStore;
  writerIngressBarrier?: WriterIngressBarrier;
  hooks?: { afterDurableCommit?: (documentIds: readonly DocumentId[]) => Promise<void> };
};

export function createBranchPushExecutor(input: BranchPushExecutorInput): BranchPushService {
  const criticalSections = input.criticalSections ?? createBranchCriticalSections();
  const computePushUpdate = input.pushUpdateComputer ?? wholeBranchPushUpdate;
  const attributionCodec = createAgentEditCodec(input.codec);
  const transition = createBranchPushTransition({
    pushStore: input.pushStore,
    liveCoordinator: input.liveCoordinator,
    model: input.model,
    codec: attributionCodec,
    writerIngressBarrier: input.writerIngressBarrier,
  });

  async function loadLiveDoc(documentId: DocumentId): Promise<Y.Doc> {
    const snapshot = await input.journal.read(documentId);
    const doc = createCollabYDoc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    return doc;
  }

  function materializeBranch(branch: BranchSnapshot): Y.Doc {
    const doc = createCollabYDoc({ gc: false });
    Y.applyUpdate(doc, branch.state);
    return doc;
  }

  async function compute(
    branch: BranchSnapshot,
    options: {
      pushKind?: "whole" | "selective";
      selectRows?: (row: BranchJournalRow) => boolean;
    } = {},
  ): Promise<{
    branch: BranchSnapshot;
    rows: BranchJournalRow[];
    pushUpdate: Uint8Array;
    receipt: PushReceiptPayload;
    markdownProjection: string;
    liveStateVector: Uint8Array;
    liveState: Uint8Array;
    idempotencyKey: string;
    receiptId: string;
    baselineState: Uint8Array;
    rowBaselineStates: ReadonlyMap<number, Uint8Array>;
    conflictEcho?: BranchPushConflictEcho;
  }> {
    const reviewableRows = await listReviewableRows(branch.branchId, branch.generation);
    const rows = options.selectRows ? reviewableRows.filter(options.selectRows) : reviewableRows;
    if (rows.length === 0) {
      const existing = await input.pushStore.latestPushForBranch?.(
        branch.branchId,
        branch.generation,
      );
      if (existing) throw new NoActiveRowsExistingPush(existing);
      throw new NoActiveRowsNoop(branch);
    }
    const pushKind = options.pushKind ?? "whole";
    const baselineUpdateSeq = Math.min(...rows.map((row) => row.draftBaseUpdateSeq));
    const baselineSnapshots = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.draftBaseUpdateSeq))].map(
          async (seq) =>
            [seq, await input.journal.read(branch.documentId, { until: seq })] as const,
        ),
      ),
    );
    const rowBaselineStates = new Map<number, Uint8Array>();
    for (const [seq, snapshot] of baselineSnapshots) {
      const doc = createCollabYDoc({ gc: false });
      if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
      for (const journalRow of snapshot.updates) Y.applyUpdate(doc, journalRow.update);
      rowBaselineStates.set(seq, Y.encodeStateAsUpdate(doc));
      doc.destroy();
    }
    const baselineDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(baselineDoc, rowBaselineStates.get(baselineUpdateSeq) as Uint8Array);
    const liveDoc = await loadLiveDoc(branch.documentId);
    const afterDoc = createCollabYDoc({ gc: false });
    let branchDoc: Y.Doc | null = null;
    try {
      if (pushKind === "selective") {
        Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(liveDoc));
        for (const row of rows) Y.applyUpdate(afterDoc, row.updateData);
        assertNoPendingIntegration(
          afterDoc,
          "selective_push_peer",
          rows.map((row) => row.id),
        );
        assertRowsIntegrated(afterDoc, rows, "selective_push_peer");
      } else {
        branchDoc = materializeBranch(branch);
        const wholeUpdate = computePushUpdate({ branch, branchDoc, liveDoc });
        Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(liveDoc));
        Y.applyUpdate(afterDoc, wholeUpdate);
      }
      const pushUpdate =
        pushKind === "selective"
          ? Y.encodeStateAsUpdate(afterDoc, Y.encodeStateVector(liveDoc))
          : computePushUpdate({ branch, branchDoc: branchDoc as Y.Doc, liveDoc });
      const receipt = buildReceipt({
        model: input.model,
        documentId: branch.documentId,
        branch,
        pushKind,
        beforeDoc: liveDoc,
        afterDoc,
      });
      const markdownProjection = markdownFromDoc(input.model, input.codec, afterDoc);
      const liveState = Y.encodeStateAsUpdate(afterDoc);
      const liveStateVector = Y.encodeStateVector(afterDoc);
      const idempotencyKey = stablePushIdempotencyKey({
        branchId: branch.branchId,
        generation: branch.generation,
        journalIds: rows.map((row) => row.id),
        pushKind,
      });
      return {
        branch,
        rows,
        pushUpdate,
        receipt,
        markdownProjection,
        liveStateVector,
        liveState,
        idempotencyKey,
        receiptId: randomUUID(),
        baselineState: Y.encodeStateAsUpdate(baselineDoc),
        rowBaselineStates,
        conflictEcho:
          pushKind === "whole"
            ? conflictEchoFrom({
                currentBranch: branch,
                currentRows: rows,
                currentReceipt: receipt,
                priorPushes: await input.pushStore.listPushesForDocument?.(branch.documentId),
              })
            : undefined,
      };
    } finally {
      branchDoc?.destroy();
      afterDoc.destroy();
      liveDoc.destroy();
      baselineDoc.destroy();
    }
  }

  type ComputedPush = Awaited<ReturnType<typeof compute>>;

  async function prepareUnderLiveLock(
    phase: ComputedPush,
    lockCutUpdate: Uint8Array,
    receiptId = phase.receiptId,
  ) {
    const lockCutDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(lockCutDoc, lockCutUpdate);
    const before = snapshotBlocks(toDocHandle(lockCutDoc), input.model, attributionCodec);
    const afterDoc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(afterDoc, lockCutUpdate);
      Y.applyUpdate(afterDoc, phase.pushUpdate);
      const after = snapshotBlocks(toDocHandle(afterDoc), input.model, attributionCodec);
      const candidateEffects = diffSnapshots(before, after);
      const journal = await input.journal.read(phase.branch.documentId);
      const beforeByHash = new Map(before.map((block) => [block.hash, block]));
      const afterSnapshotByHash = new Map(after.map((block) => [block.hash, block]));
      const conflictEvidence = new Map<
        string,
        {
          row: BranchJournalRow;
          base: (typeof before)[number] | undefined;
          resurrection?: (typeof before)[number];
          ambiguous?: boolean;
        }
      >();
      const resurrectionBodies = new Map<string, (typeof before)[number]>();
      const rowAssociatedEffects = new Set<string>();
      let protectedDeletionSeen = false;
      for (const row of phase.rows) {
        const baselineState = phase.rowBaselineStates.get(row.draftBaseUpdateSeq);
        if (!baselineState)
          throw new Error(`missing immutable draft base ${row.draftBaseUpdateSeq}`);
        const coverage = partitionByBlockCoverage({
          baselineState,
          upstreamState: lockCutUpdate,
          rows: journal.updates
            .filter((update) => update.seq > row.draftBaseUpdateSeq)
            .map((update) => ({
              id: update.seq,
              source: update.meta.origin.startsWith("human:") ? "writer" : "agent",
              actorTurnId: update.meta.actorTurnId,
              update: update.update,
            })),
          model: input.model,
          codec: attributionCodec,
        });
        const humanTouched = new Set(coverage.humanResidualHashes);
        for (const [hash, owner] of coverage.coverage) {
          if (owner.origin === "writer") humanTouched.add(hash);
        }
        for (const [hash, owner] of coverage.deletedCoverage) {
          if (owner.origin === "writer") humanTouched.add(hash);
        }
        for (const hash of coverage.humanDeletedHashes) humanTouched.add(hash);

        const rowAfterDoc = createCollabYDoc({ gc: false });
        Y.applyUpdate(rowAfterDoc, lockCutUpdate);
        Y.applyUpdate(rowAfterDoc, row.updateData);
        const rowAfter = snapshotBlocks(toDocHandle(rowAfterDoc), input.model, attributionCodec);
        rowAfterDoc.destroy();
        const rowEffects = diffSnapshots(before, rowAfter);
        for (const hash of [...rowEffects.changed, ...rowEffects.deleted, ...rowEffects.inserted]) {
          rowAssociatedEffects.add(hash);
        }
        for (const hash of [...rowEffects.changed, ...rowEffects.deleted]) {
          if (
            humanTouched.has(hash) &&
            (candidateEffects.changed.has(hash) || candidateEffects.deleted.has(hash))
          ) {
            conflictEvidence.set(hash, { row, base: undefined });
          }
        }

        const baselineDoc = createCollabYDoc({ gc: false });
        Y.applyUpdate(baselineDoc, baselineState);
        const baselineBlocks = snapshotBlocks(
          toDocHandle(baselineDoc),
          input.model,
          attributionCodec,
        );
        baselineDoc.destroy();
        const baselineByHash = new Map(baselineBlocks.map((block) => [block.hash, block]));
        for (const [hash, evidence] of conflictEvidence) {
          if (evidence.row.id === row.id) evidence.base = baselineByHash.get(hash);
        }
        const protectedDeletedHashes = new Set(coverage.humanDeletedHashes);
        for (const [hash, owner] of coverage.deletedCoverage) {
          if (owner.origin === "writer" && !beforeByHash.has(hash))
            protectedDeletedHashes.add(hash);
        }
        const deletedBaselineBlocks = [...protectedDeletedHashes].flatMap((hash) => {
          const block = baselineByHash.get(hash);
          return block ? [block] : [];
        });
        if (deletedBaselineBlocks.length > 0) protectedDeletionSeen = true;
        for (const insertedHash of rowEffects.inserted) {
          if (!candidateEffects.inserted.has(insertedHash)) continue;
          const inserted = afterSnapshotByHash.get(insertedHash);
          if (!inserted) continue;
          const deletedBase = deletedBaselineBlocks.find(
            (block) => block.clientID === inserted.clientID && block.clock === inserted.clock,
          );
          if (deletedBase) {
            resurrectionBodies.set(insertedHash, deletedBase);
            conflictEvidence.set(insertedHash, {
              row,
              base: deletedBase,
              resurrection: deletedBase,
            });
          } else if (deletedBaselineBlocks.length > 0) {
            // The row inserts after a protected canonical deletion, but Yjs ancestry
            // cannot associate it with exactly one deleted block. Refuse/report the
            // ambiguity without inventing a resurrection claim from equal bytes.
            conflictEvidence.set(insertedHash, { row, base: undefined, ambiguous: true });
          }
        }
      }
      if (protectedDeletionSeen) {
        const fallbackRow = [...phase.rows].sort(
          (left, right) => left.draftBaseUpdateSeq - right.draftBaseUpdateSeq,
        )[0];
        if (fallbackRow) {
          for (const insertedHash of candidateEffects.inserted) {
            if (!rowAssociatedEffects.has(insertedHash)) {
              conflictEvidence.set(insertedHash, {
                row: fallbackRow,
                base: undefined,
                ambiguous: true,
              });
            }
          }
        }
      }
      const allConflicts = [...conflictEvidence.keys()].sort();
      const attribution = journalAttributionByChangedBlock({
        liveDoc: lockCutDoc,
        rows: phase.rows,
        model: input.model,
      });
      const sealedLineage: SettlementLineageEvidenceV2["items"] = [];
      const sealedTokens: ReturnType<typeof parseSealedWriterLineageV3>[] = [];
      for (const row of phase.rows) {
        const raw = (row.updateMeta as { sealedWriterLineage?: unknown } | null)
          ?.sealedWriterLineage;
        const authoringResponseId = (row.updateMeta as { authoringResponseId?: unknown } | null)
          ?.authoringResponseId;
        try {
          const token = parseSealedWriterLineageV3(raw);
          if (token.documentId === phase.branch.documentId) sealedTokens.push(token);
          if (
            token.documentId === phase.branch.documentId &&
            typeof authoringResponseId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              authoringResponseId,
            )
          ) {
            sealedLineage.push({
              evidenceId: `branch-journal:${row.id}`,
              authoringResponseId,
              token,
            });
          }
        } catch {
          // Invalid or stale metadata is not evidence.
        }
      }
      const afterLineage = after.flatMap((block) => block.lineage ?? []);
      const sealedSweptBlocks = before.filter((block) =>
        sealedTokens.some((token) =>
          token.protectedRoots.some(
            (range) =>
              lineageCovered(range, block.lineage ?? []) && !lineageCovered(range, afterLineage),
          ),
        ),
      );
      const conflicts: DraftApplyConflict[] = allConflicts.map((blockId) => {
        const evidence = conflictEvidence.get(blockId) as NonNullable<
          ReturnType<typeof conflictEvidence.get>
        >;
        const resurrection = evidence.resurrection;
        const base = resurrection ?? evidence.base;
        const live = beforeByHash.get(blockId);
        const proposed = afterSnapshotByHash.get(blockId);
        const effect = resurrection ? "resurrection" : proposed ? "overwrite" : "delete";
        return {
          blockId,
          journalIds: [evidence.row.id],
          draftBaseUpdateSeq: evidence.row.draftBaseUpdateSeq,
          effect,
          evidence: resurrection
            ? "human_live_deletion"
            : evidence.ambiguous
              ? "ambiguous_protected_divergence"
              : "human_live_change",
          captured: {
            base: base?.serialized ?? null,
            live: live?.serialized ?? null,
            proposed: proposed?.serialized ?? null,
          },
          why: resurrection
            ? "Apply would make content deleted by the writer after this draft began visible again."
            : evidence.ambiguous
              ? "Apply inserts content after a protected writer deletion, but canonical ancestry cannot prove which block it covers."
              : "Apply would delete or overwrite live content changed by the writer after this draft began.",
        };
      });
      const observationBlindConflicts = await unobservedConflictBlocks({
        documentId: phase.branch.documentId,
        conflicts,
        authoringResponseIdsByBlock: attribution.authoringResponseIdsByBlock,
        beforeByHash,
        resurrectionBodies,
      });
      // Draft bases govern Apply refusal only. Commit-sealed sweep evidence is an
      // observation fact and remains trail-worthy even when the pulled writer row
      // is at or before every selected draft row's base.
      const blindConflictedBlocks = [
        ...new Set([...observationBlindConflicts, ...sealedSweptBlocks.map((block) => block.hash)]),
      ].sort();
      const conflictedBlocks = allConflicts;
      const afterBlocks = input.model.getBlocks(toDocHandle(afterDoc));
      const afterXmlBlocks = afterDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toArray();
      const afterById = new Map(
        afterBlocks.flatMap((block, index) => {
          const xml = afterXmlBlocks[index];
          return xml instanceof Y.XmlElement ? [[input.model.getBlockId(block), xml] as const] : [];
        }),
      );
      const afterIds = new Set(after.map((block) => block.hash));
      const beforeBodies = new Map(before.map((block) => [block.hash, block.serialized]));
      for (const block of sealedSweptBlocks) beforeBodies.set(block.hash, block.serialized);
      for (const [hash, block] of resurrectionBodies) beforeBodies.set(hash, block.serialized);
      const blockIdentities = new Map(
        [...before, ...after].flatMap((block) =>
          block.clientID === undefined || block.clock === undefined
            ? []
            : [
                [
                  block.hash,
                  {
                    documentId: phase.branch.documentId,
                    clientID: block.clientID,
                    clock: block.clock,
                  },
                ] as const,
              ],
        ),
      );
      const changes: RawTrailChange[] = preparedTrailChanges({
        receipt: buildReceipt({
          model: input.model,
          documentId: phase.branch.documentId,
          branch: phase.branch,
          pushKind: phase.receipt.pushKind,
          beforeDoc: lockCutDoc,
          afterDoc,
        }),
        receiptId,
        ownersByBlock: attribution.ownersByBlock,
        operations: attribution.operations.map((operation) => ({
          ...operation,
          insertedBlocks: operation.insertedBlockIds.flatMap((blockId) => {
            const block = afterById.get(blockId);
            return block ? [{ blockId, block }] : [];
          }),
        })),
        conflictedBlocks: blindConflictedBlocks,
        before,
        blockIdentities,
        beforeBodies,
        afterIds,
        afterById,
        afterDoc,
        beforeContentRef: journal.updates.at(-1)?.seq ?? null,
        resurrectionBodies: new Map(
          [...resurrectionBodies].map(([hash, block]) => [hash, block.serialized]),
        ),
      });
      return {
        conflictedBlocks,
        blindConflictedBlocks,
        conflicts,
        beforeContentRef: journal.updates.at(-1)?.seq ?? null,
        trailChanges: changes,
        lineageEvidence: { version: 2, items: sealedLineage },
        lockCutUpdate,
        prepared: {
          branch: phase.branch,
          journalRows: phase.rows,
          pushUpdate: phase.pushUpdate,
          receiptPayload: buildReceipt({
            model: input.model,
            documentId: phase.branch.documentId,
            branch: phase.branch,
            pushKind: phase.receipt.pushKind,
            beforeDoc: lockCutDoc,
            afterDoc,
          }),
          idempotencyKey: phase.idempotencyKey,
          receiptId,
          markdownProjection: markdownFromDoc(input.model, input.codec, afterDoc),
          liveStateVector: Y.encodeStateVector(afterDoc),
          liveState: Y.encodeStateAsUpdate(afterDoc),
        } satisfies Omit<PreparedPushCommit, "pushedByUserId" | "trail" | "pendingLiveSettlement">,
      };
    } finally {
      afterDoc.destroy();
      lockCutDoc.destroy();
    }
  }

  async function unobservedConflictBlocks(inputConflict: {
    documentId: DocumentId;
    conflicts: readonly DraftApplyConflict[];
    authoringResponseIdsByBlock: ReadonlyMap<string, readonly string[]>;
    beforeByHash: ReadonlyMap<string, ReturnType<typeof snapshotBlocks>[number]>;
    resurrectionBodies: ReadonlyMap<string, ReturnType<typeof snapshotBlocks>[number]>;
  }): Promise<string[]> {
    if (!input.observations) return inputConflict.conflicts.map((conflict) => conflict.blockId);
    const responseIds = [
      ...new Set([...inputConflict.authoringResponseIdsByBlock.values()].flat()),
    ];
    const snapshots = await Promise.all(responseIds.map((id) => input.observations?.load(id)));
    const blind: string[] = [];
    for (const conflict of inputConflict.conflicts) {
      const conflictResponseIds = new Set(
        inputConflict.authoringResponseIdsByBlock.get(conflict.blockId) ?? [],
      );
      const block =
        inputConflict.resurrectionBodies.get(conflict.blockId) ??
        inputConflict.beforeByHash.get(conflict.blockId);
      if (
        !block ||
        block.clientID === undefined ||
        block.clock === undefined ||
        block.renderedContent === undefined
      ) {
        blind.push(conflict.blockId);
        continue;
      }
      const observed = snapshots.some((snapshot) => {
        if (!snapshot || !conflictResponseIds.has(snapshot.responseId)) return false;
        const value = snapshot?.entries.find(
          (entry) =>
            entry.documentId === inputConflict.documentId &&
            entry.clientID === block.clientID &&
            entry.clock === block.clock,
        )?.value;
        return observationCoversRendering({
          observation: value ?? null,
          renderedContent: block.renderedContent as string,
          digestRenderedContent,
        });
      });
      if (!observed) blind.push(conflict.blockId);
    }
    return blind;
  }

  async function pushSweptTrail(
    prepared: Awaited<ReturnType<typeof prepareUnderLiveLock>>,
  ): Promise<PushSweptTrail> {
    const sweptChanges = prepared.trailChanges.filter((change) => change.swept !== null);
    return {
      affectedBlockHashes: prepared.blindConflictedBlocks,
      capturedDeletedBodies: sweptChanges.map((change) => ({
        hash: change.swept?.affectedBlockHash as string,
        body:
          change.swept?.removed.status === "available"
            ? change.swept.removed.markdown
            : "body_unavailable",
      })),
      beforeContentRef: prepared.beforeContentRef,
      receiptId: prepared.prepared.receiptId as string,
      locations: sweptChanges.map((change) => ({
        changeId: change.changeId,
        affectedBlockHash: change.swept?.affectedBlockHash as string,
        outcome: change.kind === "modify" ? "modify" : "delete",
        navigation: change.navigation,
      })),
      // Push-target reversal is not an exposed contract yet. Retaining a
      // baseline alone must never be presented as an undo affordance.
      reversible: false,
    };
  }

  function durableTrailRecord(inputRecord: {
    prepared: Awaited<ReturnType<typeof prepareUnderLiveLock>>;
    documentTitle: string;
    swept?: PushSweptTrail;
  }): DurableTrailRecord {
    const journalOwners = inputRecord.prepared.prepared.journalRows.map((row) =>
      row.threadId && row.turnId ? { threadId: row.threadId, turnId: row.turnId } : null,
    );
    const threadIds = new Set(
      inputRecord.prepared.prepared.journalRows.flatMap((row) =>
        row.threadId ? [row.threadId] : [],
      ),
    );
    return {
      documentId: inputRecord.prepared.prepared.branch.documentId,
      documentTitle: inputRecord.documentTitle,
      receiptId: inputRecord.prepared.prepared.receiptId as string,
      threadIds: [...threadIds],
      journalOwners,
      changes: inputRecord.prepared.trailChanges,
      ...(inputRecord.swept
        ? {
            transactionalNotice: {
              kind: "push_swept",
              scope: {
                kind: "document",
                documentId: inputRecord.prepared.prepared.branch.documentId,
              },
              writerVisible: true,
              message:
                "AI applied changes that removed words not yet synced to the agent — View change",
              data: {
                documentId: inputRecord.prepared.prepared.branch.documentId,
                documentName: inputRecord.documentTitle,
                pushId: "pending",
                ...inputRecord.swept,
              },
            } satisfies NoticeInput,
          }
        : {}),
    };
  }

  function pendingLiveSettlement(
    prepared: Awaited<ReturnType<typeof prepareUnderLiveLock>>,
    documentTitle: string,
    trail: DurableTrailRecord,
  ): Omit<PendingLiveSettlement, "push"> {
    return transition.prepare({
      documentTitle,
      provenanceView: [],
      lineageEvidence: { version: 2 as const, items: prepared.lineageEvidence.items },
      responseEvidence: [],
      lockCutUpdate: prepared.lockCutUpdate,
      pushUpdate: prepared.prepared.pushUpdate,
      beforeContentRef: prepared.beforeContentRef,
      trail,
    });
  }

  async function listReviewableRows(
    branchId: string,
    generation: number,
  ): Promise<BranchJournalRow[]> {
    return (input.pushStore.listReviewableJournalRows ?? input.pushStore.listActiveJournalRows)(
      branchId,
      generation,
    );
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
          const branches = await Promise.all(branchIds.map(loadActiveWorkDraftBranch));
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

  async function loadActiveWorkDraftBranch(branchId: string): Promise<BranchSnapshot> {
    return assertActiveWorkDraftBranch(await input.branchStore.getBranch(branchId), branchId);
  }

  function mapNoActiveRows(cause: unknown): PushToLiveResult | null {
    if (cause instanceof NoActiveRowsExistingPush) {
      return { status: "already_pushed", push: cause.push };
    }
    if (cause instanceof NoActiveRowsNoop) {
      return {
        status: "noop",
        branchId: cause.branch.branchId,
        documentId: cause.branch.documentId,
        branchGeneration: cause.branch.generation,
        reason: "no_active_rows",
      };
    }
    return null;
  }

  async function resetAutoBranchIfDrained(
    lease: BranchLockLease,
    branch: BranchSnapshot,
    liveAfterPush: Uint8Array,
    targetPolicy: "manual" | "auto" = branch.pushPolicy,
  ): Promise<{ branchId: string; fromGeneration: number } | undefined> {
    if (targetPolicy !== "auto" || !input.branchCoordinator) return undefined;
    const activeRows = await input.pushStore.listActiveJournalRows(
      branch.branchId,
      branch.generation,
    );
    if (activeRows.length > 0) return undefined;
    const fromGeneration = branch.generation;
    const liveDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(liveDoc, liveAfterPush);
    const reset = await input.branchCoordinator.resetFromDocIfUnchangedWithLease(lease, {
      branchId: branch.branchId,
      upstream: liveDoc,
      expectedGeneration: branch.generation,
      expectedStateVector: branch.stateVector,
      expectedState: branch.state,
      schemaVersion: branch.schemaVersion,
    });
    return reset ? { branchId: branch.branchId, fromGeneration } : undefined;
  }

  async function executeWhole(inputPush: {
    branchId: string;
    pushedByUserId?: UserId;
    resetPolicy?: "manual" | "auto";
    signal?: AbortSignal;
    overlapPolicy?: "refuse" | "apply_and_trail";
  }): Promise<PushToLiveResult> {
    return withActiveWorkDraftBranchLock<PushToLiveResult>(
      [inputPush.branchId],
      async ([branch], lease) => {
        if (!branch) throw new Error("active work draft lock did not provide its branch");
        // Phase 1: read-only compute. No branch coordinator lock and no live coordinator lock.
        let phase1: Awaited<ReturnType<typeof compute>>;
        try {
          phase1 = await compute(branch);
        } catch (cause) {
          const mapped = mapNoActiveRows(cause);
          if (mapped) return mapped;
          throw cause;
        }

        const locked = await transition.execute<
          | PushToLiveResult
          | {
              kind: "committed";
              committed: PushLineageRow;
              liveAfterPush: Uint8Array;
              swept?: PushSweptTrail;
            }
        >({
          documentIds: [phase1.branch.documentId],
          signal: inputPush.signal,
          prepare: async ({ docs, lockCuts }) => {
            const liveDoc = docs.get(phase1.branch.documentId);
            if (!liveDoc) throw new Error("live push lock did not provide its document");
            const gated = await prepareUnderLiveLock(
              phase1,
              lockCuts.get(phase1.branch.documentId) as Uint8Array,
            );
            if (
              gated.conflictedBlocks.length > 0 &&
              inputPush.overlapPolicy !== "apply_and_trail"
            ) {
              return {
                kind: "return" as const,
                value: {
                  status: "push_concurrent_conflict" as const,
                  reason: "draft_base_divergence" as const,
                  conflictedBlocks: gated.conflictedBlocks,
                  conflicts: gated.conflicts,
                },
              };
            }
            const needsSweptTrail =
              inputPush.overlapPolicy === "apply_and_trail" &&
              gated.blindConflictedBlocks.length > 0;
            if (needsSweptTrail && !input.notices) {
              throw new Error("apply_and_trail requires a durable notice recorder");
            }
            const swept = needsSweptTrail ? await pushSweptTrail(gated) : undefined;
            const trailDocumentName = await resolveDocumentTitle(phase1.branch.documentId);
            const trail = durableTrailRecord({
              prepared: gated,
              documentTitle: trailDocumentName,
              swept,
            });
            const pendingSettlement = pendingLiveSettlement(gated, trailDocumentName, trail);
            return {
              kind: "push" as const,
              pushes: [
                {
                  ...gated.prepared,
                  pushedByUserId: inputPush.pushedByUserId,
                  trail,
                  pendingLiveSettlement: pendingSettlement,
                },
              ],
              afterDurableCommit: input.hooks?.afterDurableCommit,
              onConflict: (push: PushLineageRow) => ({
                status: "already_pushed" as const,
                push,
                ...(phase1.conflictEcho ? { conflictEcho: phase1.conflictEcho } : {}),
              }),
              finish: ({ pushes, swept: lateSweeps, docs: completedDocs }) => ({
                kind: "committed" as const,
                committed: pushes[0] as PushLineageRow,
                liveAfterPush: Y.encodeStateAsUpdate(
                  completedDocs.get(phase1.branch.documentId) as Y.Doc,
                ),
                swept: lateSweeps[0] ?? swept,
              }),
            };
          },
        });
        if (!("kind" in locked) || locked.kind !== "committed") {
          return locked as PushToLiveResult;
        }
        const completed = locked as {
          kind: "committed";
          committed: PushLineageRow;
          liveAfterPush: Uint8Array;
          swept?: PushSweptTrail;
        };

        const branchReset = await resetAutoBranchIfDrained(
          lease,
          phase1.branch,
          completed.liveAfterPush,
          inputPush.resetPolicy,
        );

        return {
          status: "pushed",
          push: completed.committed,
          update: phase1.pushUpdate,
          ...(phase1.conflictEcho ? { conflictEcho: phase1.conflictEcho } : {}),
          ...(branchReset ? { branchReset } : {}),
          ...(completed.swept ? { swept: completed.swept } : {}),
        };
      },
    );
  }

  async function executeCompanion(inputPush: {
    branchId: string;
    manifestBranchId: string;
    manifestEntryDocumentId: DocumentId;
    contentJournalIds?: readonly number[];
    pushedByUserId?: UserId;
    signal?: AbortSignal;
    overlapPolicy?: "refuse" | "apply_and_trail";
  }): Promise<PushToLiveResult> {
    if (!input.pushStore.commitPushBatch) {
      throw new Error("Branch push store does not support atomic companion pushes");
    }
    // A4.2 J4: companion candidate production is routed through the aggregate's
    // batched staged-push transition when settlement/outbox ownership moves.
    return withActiveWorkDraftBranchLock<PushToLiveResult>(
      [inputPush.branchId, inputPush.manifestBranchId],
      async ([contentBranch, manifestBranch]) => {
        if (!contentBranch || !manifestBranch) {
          throw new Error("active work draft locks did not provide both branches");
        }
        let content: Awaited<ReturnType<typeof compute>>;
        try {
          const contentJournalIds = inputPush.contentJournalIds
            ? new Set(inputPush.contentJournalIds)
            : null;
          content = await compute(
            contentBranch,
            contentJournalIds
              ? {
                  pushKind: "selective",
                  selectRows: (row) => contentJournalIds.has(row.id),
                }
              : undefined,
          );
          if (contentJournalIds && content.rows.length !== contentJournalIds.size) {
            throw new BranchPushCommitConflictError(inputPush.branchId);
          }
        } catch (cause) {
          const mapped = mapNoActiveRows(cause);
          if (mapped) return mapped;
          throw cause;
        }

        let manifest: Awaited<ReturnType<typeof compute>> | null = null;
        try {
          manifest = await compute(manifestBranch, {
            pushKind: "selective",
            selectRows: (row) =>
              manifestMembershipRowDocumentId(row) === inputPush.manifestEntryDocumentId,
          });
        } catch (cause) {
          if (
            !(cause instanceof NoActiveRowsNoop) &&
            !(cause instanceof NoActiveRowsExistingPush)
          ) {
            throw cause;
          }
        }

        const phases = [content, ...(manifest ? [manifest] : [])];
        const locked = await transition.execute<
          | PushToLiveResult
          | {
              kind: "committed";
              committed: readonly PushLineageRow[];
              swept?: PushSweptTrail;
            }
        >({
          documentIds: phases.map((phase) => phase.branch.documentId),
          signal: inputPush.signal,
          prepare: async ({ docs, lockCuts }) => {
            // One receipt identifies the entire companion transaction. Prepare trail
            // identities from that receipt rather than each phase's provisional ID.
            const receiptId = randomUUID();
            const gated = [];
            for (const [phaseIndex, phase] of phases.entries()) {
              const liveDoc = docs.get(phase.branch.documentId);
              if (!liveDoc) throw new Error("live batch push lock did not provide its document");
              const prepared = await prepareUnderLiveLock(
                phase,
                lockCuts.get(phase.branch.documentId) as Uint8Array,
                receiptId,
              );
              if (
                prepared.conflictedBlocks.length > 0 &&
                (phaseIndex !== 0 || inputPush.overlapPolicy !== "apply_and_trail")
              ) {
                return {
                  kind: "return" as const,
                  value: {
                    status: "push_concurrent_conflict" as const,
                    reason: "draft_base_divergence" as const,
                    conflictedBlocks: prepared.conflictedBlocks,
                    conflicts: prepared.conflicts,
                  },
                };
              }
              gated.push(prepared);
            }
            const titles = await Promise.all(
              phases.map((phase) => resolveDocumentTitle(phase.branch.documentId)),
            );
            const swept =
              inputPush.overlapPolicy === "apply_and_trail" &&
              (gated[0]?.blindConflictedBlocks.length ?? 0) > 0
                ? await pushSweptTrail(gated[0] as (typeof gated)[number])
                : undefined;
            const pushes = gated.map((gatedPush, index) => {
              const documentTitle = titles[index] ?? "Untitled document";
              const trail = durableTrailRecord({
                prepared: gatedPush,
                documentTitle,
                ...(index === 0 && swept ? { swept } : {}),
              });
              return {
                ...gatedPush.prepared,
                receiptId,
                pushedByUserId: inputPush.pushedByUserId,
                trail,
                pendingLiveSettlement: pendingLiveSettlement(gatedPush, documentTitle, trail),
              };
            });
            return {
              kind: "push" as const,
              pushes,
              afterDurableCommit: input.hooks?.afterDurableCommit,
              onConflict: () => {
                throw new BranchPushCommitConflictError(pushes[0]?.branch.branchId ?? "unknown");
              },
              finish: ({ pushes: committed, swept: lateSweeps }) => ({
                kind: "committed" as const,
                committed,
                swept: lateSweeps[0] ?? swept,
              }),
            };
          },
        });
        if (!("kind" in locked) || locked.kind !== "committed") {
          return locked as PushToLiveResult;
        }
        const completed = locked as {
          kind: "committed";
          committed: readonly PushLineageRow[];
          swept?: PushSweptTrail;
        };

        return {
          status: "pushed",
          push: completed.committed[0] as PushLineageRow,
          update: content.pushUpdate,
          ...(content.conflictEcho ? { conflictEcho: content.conflictEcho } : {}),
          ...(completed.swept ? { swept: completed.swept } : {}),
        };
      },
    );
  }

  async function executeSelective(inputPush: {
    branchId: string;
    journalIds: readonly number[];
    pushedByUserId?: UserId;
    signal?: AbortSignal;
  }): Promise<PushToLiveResult> {
    const selected = new Set(inputPush.journalIds);
    if (selected.size === 0) {
      throw new Error("selective_push_requires_rows");
    }
    return withActiveWorkDraftBranchLock([inputPush.branchId], async ([branch]) => {
      const phase1 = await compute(branch, {
        pushKind: "selective",
        selectRows: (row) => selected.has(row.id),
      });
      if (phase1.rows.length !== selected.size) {
        throw new BranchPushCommitConflictError(inputPush.branchId);
      }
      return transition.execute<PushToLiveResult>({
        documentIds: [phase1.branch.documentId],
        signal: inputPush.signal,
        prepare: async ({ docs, lockCuts }) => {
          const liveDoc = docs.get(phase1.branch.documentId);
          if (!liveDoc) throw new Error("live selective push lock did not provide its document");
          const gated = await prepareUnderLiveLock(
            phase1,
            lockCuts.get(phase1.branch.documentId) as Uint8Array,
          );
          if (gated.conflictedBlocks.length > 0) {
            return {
              kind: "return" as const,
              value: {
                status: "push_concurrent_conflict" as const,
                reason: "draft_base_divergence" as const,
                conflictedBlocks: gated.conflictedBlocks,
                conflicts: gated.conflicts,
              },
            };
          }
          const trailDocumentName = await resolveDocumentTitle(phase1.branch.documentId);
          const trail = durableTrailRecord({
            prepared: gated,
            documentTitle: trailDocumentName,
          });
          const pendingSettlement = pendingLiveSettlement(gated, trailDocumentName, trail);
          return {
            kind: "push" as const,
            pushes: [
              {
                ...gated.prepared,
                pushedByUserId: inputPush.pushedByUserId,
                trail,
                pendingLiveSettlement: pendingSettlement,
              },
            ],
            afterDurableCommit: input.hooks?.afterDurableCommit,
            onConflict: (push: PushLineageRow) => ({
              status: "already_pushed" as const,
              push,
            }),
            finish: ({ pushes, swept }) => ({
              status: "pushed" as const,
              push: pushes[0] as PushLineageRow,
              update: phase1.pushUpdate,
              ...(swept[0] ? { swept: swept[0] } : {}),
            }),
          };
        },
      });
    });
  }

  type PushExecutionSpec =
    | {
        kind: "whole";
        input: Parameters<BranchPushService["pushToLive"]>[0] & { resetPolicy?: "manual" | "auto" };
      }
    | { kind: "selective"; input: Parameters<BranchPushService["pushSelectedToLive"]>[0] }
    | { kind: "companion"; input: Parameters<BranchPushService["pushToLiveWithManifestEntry"]>[0] };

  async function execute(spec: PushExecutionSpec): Promise<PushToLiveResult> {
    switch (spec.kind) {
      case "whole":
        return executeWhole(spec.input);
      case "selective":
        return executeSelective(spec.input);
      case "companion":
        return executeCompanion(spec.input);
    }
  }

  const pushToLive: BranchPushService["pushToLive"] = (inputPush) =>
    execute({ kind: "whole", input: inputPush });
  const pushSelectedToLive: BranchPushService["pushSelectedToLive"] = (inputPush) =>
    execute({ kind: "selective", input: inputPush });
  const pushToLiveWithManifestEntry: BranchPushService["pushToLiveWithManifestEntry"] = (
    inputPush,
  ) => execute({ kind: "companion", input: inputPush });

  const { discardSelected, reverseBranchTurn } = createBranchReviewOperations({
    pushStore: input.pushStore,
    broadcastUpdate: input.branchCoordinator?.broadcastUpdate,
    withActiveWorkDraftBranchLock,
    listReviewableRows,
    loadLiveDoc,
    materializeBranch,
  });

  async function resolveDocumentTitle(documentId: DocumentId): Promise<string> {
    const resolved = (await input.resolveDocumentTitle?.(documentId))?.trim();
    return resolved || "Untitled document";
  }

  const workPushPolicy = createWorkPushPolicy({
    branchStore: input.branchStore,
    pushStore: input.pushStore,
    pushToLive,
  });

  return {
    pushToLive,
    pushSelectedToLive,
    discardSelected,
    reverseBranchTurn,
    pushToLiveWithManifestEntry,
    recoverPendingLiveSettlements: transition.recover,

    ...workPushPolicy,

    async markFailedResponseRollbackPending(rollbackInput) {
      if (input.pushStore.listJournalRowsForTurn && input.pushStore.commitDiscard) {
        const reversed = await reverseBranchTurn({
          ...rollbackInput,
          direction: "undo",
        });
        if (reversed.status === "reversed") {
          return {
            status: "discarded",
            branchId: reversed.branchId,
            journalIds: reversed.journalIds,
          };
        }
      }
      const branch = await input.branchStore.getBranch(rollbackInput.branchId);
      if (!branch) throw new Error(`Branch ${rollbackInput.branchId} does not exist`);
      const rowsMarked = await input.pushStore.markRollbackPending({
        ...rollbackInput,
        generation: branch.generation,
      });
      return { status: "rollback_pending", rowsMarked };
    },
  };
}

export class BranchPushCommitConflictError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} changed before its push could commit`);
    this.name = "BranchPushCommitConflictError";
  }
}

class NoActiveRowsExistingPush extends Error {
  constructor(readonly push: PushLineageRow) {
    super("Branch has no active rows and already has a push lineage row");
  }
}

class NoActiveRowsNoop extends Error {
  constructor(readonly branch: BranchSnapshot) {
    super("Branch has no active rows and no prior lineage");
  }
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
export class BranchPushRetryExhaustedError extends Error {
  constructor(
    readonly branchId: string,
    readonly maxRetries: number,
    cause?: unknown,
  ) {
    super(`Branch ${branchId} push did not commit after ${maxRetries} CAS retries`, { cause });
    this.name = "BranchPushRetryExhaustedError";
  }
}

function manifestMembershipRowDocumentId(row: BranchJournalRow): DocumentId | null {
  const meta = row.updateMeta;
  if (typeof meta !== "object" || meta === null) return null;
  const record = meta as { kind?: unknown; documentId?: unknown };
  return record.kind === "manifest_membership" && typeof record.documentId === "string"
    ? (record.documentId as DocumentId)
    : null;
}

export { BranchPeerIntegrationError } from "./branch-push-plan.js";
export { PendingLiveSettlementError } from "./branch-push-transition.js";
