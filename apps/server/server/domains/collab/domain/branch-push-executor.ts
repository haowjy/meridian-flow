/** Durable-first work-draft to live push service for branch peers. */
import { randomUUID } from "node:crypto";
import {
  createAgentEditCodec,
  type DocumentCoordinator,
  diffSnapshots,
  digestRenderedContent,
  type ObservationSnapshotStore,
  observationCoversRendering,
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
import { createBranchReviewOperations } from "./branch-review-operations.js";
import {
  journalAttributionByChangedBlock,
  preparedTrailChanges,
} from "./branch-trail-projection.js";
import { partitionByBlockCoverage } from "./branch-update-attribution.js";
import type { DurableTrailRecord } from "./ports/change-trail-persistence.js";
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
};

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
  ): Promise<{ status: "inserted" | "conflict"; push: PushLineageRow }>;
  commitDiscard?(input: PreparedDiscardCommit): Promise<void>;
  commitPushBatch?(input: { pushes: PreparedPushCommit[] }): Promise<{ pushes: PushLineageRow[] }>;
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
  recordNoticeAfterDurability?: (input: {
    notice: NoticeInput;
    threadIds: readonly ThreadId[];
    documentIds: readonly DocumentId[];
  }) => Promise<void>;
  hooks?: { afterDurableCommit?: (documentIds: readonly DocumentId[]) => Promise<void> };
};

export function createBranchPushExecutor(input: BranchPushExecutorInput): BranchPushService {
  const criticalSections = input.criticalSections ?? createBranchCriticalSections();
  const computePushUpdate = input.pushUpdateComputer ?? wholeBranchPushUpdate;
  const attributionCodec = createAgentEditCodec(input.codec);

  async function recordLateNotice(
    notice: NoticeInput,
    prepared: PreparedPushCommit | readonly PreparedPushCommit[],
  ): Promise<void> {
    const pushes: readonly PreparedPushCommit[] = Array.isArray(prepared)
      ? prepared
      : [prepared as PreparedPushCommit];
    const threadIds = [
      ...new Set(pushes.flatMap((push) => push.journalRows.flatMap((row) => row.threadId ?? []))),
    ];
    const documentIds = [...new Set(pushes.map((push) => push.branch.documentId))];
    if (input.recordNoticeAfterDurability) {
      await input.recordNoticeAfterDurability({ notice, threadIds, documentIds });
      return;
    }
    await input.notices?.record(notice);
  }

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
    // Mixed row generations are conservatively judged from the oldest immutable base.
    const baselineUpdateSeq = Math.min(...rows.map((row) => row.draftBaseUpdateSeq));
    const baselineSnapshot = await input.journal.read(branch.documentId, {
      until: baselineUpdateSeq,
    });
    const baselineDoc = createCollabYDoc({ gc: false });
    if (baselineSnapshot.checkpoint) Y.applyUpdate(baselineDoc, baselineSnapshot.checkpoint);
    for (const row of baselineSnapshot.updates) Y.applyUpdate(baselineDoc, row.update);
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
    liveDoc: Y.Doc,
    receiptId = phase.receiptId,
  ) {
    const before = snapshotBlocks(toDocHandle(liveDoc), input.model, attributionCodec);
    const afterDoc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(liveDoc));
      Y.applyUpdate(afterDoc, phase.pushUpdate);
      const after = snapshotBlocks(toDocHandle(afterDoc), input.model, attributionCodec);
      const candidateEffects = diffSnapshots(before, after);
      const deleted = candidateEffects.deleted;
      const journal = await input.journal.read(phase.branch.documentId);
      const coverage = partitionByBlockCoverage({
        baselineState: phase.baselineState,
        upstreamState: Y.encodeStateAsUpdate(liveDoc),
        rows: journal.updates.map((row) => ({
          id: row.seq,
          source: row.meta.origin.startsWith("human:") ? "writer" : "agent",
          actorTurnId: row.meta.actorTurnId,
          update: row.update,
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
      const destructive = new Set([...candidateEffects.changed, ...candidateEffects.deleted]);
      const destructiveConflicts = [...destructive].filter((hash) => humanTouched.has(hash));
      const baselineDoc = createCollabYDoc({ gc: false });
      Y.applyUpdate(baselineDoc, phase.baselineState);
      const baselineBlocks = snapshotBlocks(
        toDocHandle(baselineDoc),
        input.model,
        attributionCodec,
      );
      baselineDoc.destroy();
      const baselineByHash = new Map(baselineBlocks.map((block) => [block.hash, block]));
      const protectedDeletedHashes = new Set(coverage.humanDeletedHashes);
      for (const [hash, owner] of coverage.deletedCoverage) {
        if (owner.origin === "writer" && !before.some((block) => block.hash === hash)) {
          protectedDeletedHashes.add(hash);
        }
      }
      for (const block of baselineBlocks) {
        const current = before.find((candidate) => candidate.hash === block.hash);
        if (humanTouched.has(block.hash) && current?.renderedContent !== block.renderedContent) {
          protectedDeletedHashes.add(block.hash);
        }
      }
      const deletedBaselineBlocks = [...protectedDeletedHashes].flatMap((hash) => {
        const block = baselineByHash.get(hash);
        return block ? [block] : [];
      });
      const resurrectionBodies = new Map<string, (typeof baselineBlocks)[number]>();
      for (const insertedHash of candidateEffects.inserted) {
        const inserted = after.find((block) => block.hash === insertedHash);
        if (!inserted) continue;
        const deletedBase = deletedBaselineBlocks.find(
          (block) =>
            block.hash === insertedHash || block.renderedContent === inserted.renderedContent,
        );
        if (deletedBase) resurrectionBodies.set(insertedHash, deletedBase);
      }
      const allConflicts = [
        ...new Set([...destructiveConflicts, ...resurrectionBodies.keys()]),
      ].sort();
      const baseSeq = Math.min(...phase.rows.map((row) => row.draftBaseUpdateSeq));
      const beforeByHash = new Map(before.map((block) => [block.hash, block]));
      const afterSnapshotByHash = new Map(after.map((block) => [block.hash, block]));
      const attribution = journalAttributionByChangedBlock({
        liveDoc,
        rows: phase.rows,
        model: input.model,
      });
      const conflicts: DraftApplyConflict[] = allConflicts.map((blockId) => {
        const resurrection = resurrectionBodies.get(blockId);
        const base = resurrection ?? baselineByHash.get(blockId);
        const live = beforeByHash.get(blockId);
        const proposed = afterSnapshotByHash.get(blockId);
        const effect = resurrection ? "resurrection" : proposed ? "overwrite" : "delete";
        const exactResurrection = resurrection?.hash === blockId;
        return {
          blockId,
          journalIds: phase.rows.map((row) => row.id),
          draftBaseUpdateSeq: baseSeq,
          effect,
          evidence: resurrection
            ? exactResurrection
              ? "human_live_deletion"
              : "ambiguous_protected_divergence"
            : "human_live_change",
          captured: {
            base: base?.serialized ?? null,
            live: live?.serialized ?? null,
            proposed: proposed?.serialized ?? null,
          },
          why: resurrection
            ? exactResurrection
              ? "Apply would make content deleted by the writer after this draft began visible again."
              : "Apply may recreate content deleted by the writer after this draft began; canonical lineage is ambiguous."
            : "Apply would delete or overwrite live content changed by the writer after this draft began.",
        };
      });
      const blindConflictedBlocks = await unobservedConflictBlocks({
        documentId: phase.branch.documentId,
        conflicts,
        authoringResponseIdsByBlock: attribution.authoringResponseIdsByBlock,
        beforeByHash,
        resurrectionBodies,
      });
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
      for (const [hash, block] of resurrectionBodies) beforeBodies.set(hash, block.serialized);
      const changes: RawTrailChange[] = preparedTrailChanges({
        receipt: buildReceipt({
          model: input.model,
          documentId: phase.branch.documentId,
          branch: phase.branch,
          pushKind: phase.receipt.pushKind,
          beforeDoc: liveDoc,
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
        deletedParentHashes: deleted,
        beforeContentRef: journal.updates.at(-1)?.seq ?? null,
        trailChanges: changes,
        prepared: {
          branch: phase.branch,
          journalRows: phase.rows,
          pushUpdate: phase.pushUpdate,
          receiptPayload: buildReceipt({
            model: input.model,
            documentId: phase.branch.documentId,
            branch: phase.branch,
            pushKind: phase.receipt.pushKind,
            beforeDoc: liveDoc,
            afterDoc,
          }),
          idempotencyKey: phase.idempotencyKey,
          receiptId,
          markdownProjection: markdownFromDoc(input.model, input.codec, afterDoc),
          liveStateVector: Y.encodeStateVector(afterDoc),
          liveState: Y.encodeStateAsUpdate(afterDoc),
        } satisfies Omit<PreparedPushCommit, "pushedByUserId" | "trail">,
      };
    } finally {
      afterDoc.destroy();
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

  async function withLiveDocumentLocks<T>(
    documentIds: readonly DocumentId[],
    signal: AbortSignal | undefined,
    run: (
      docs: ReadonlyMap<DocumentId, Y.Doc>,
      lockSnapshots: ReadonlyMap<DocumentId, ReturnType<typeof snapshotBlocks>>,
    ) => Promise<T>,
  ): Promise<T> {
    const sorted = [...new Set(documentIds)].sort();
    const acquire = async (
      index: number,
      docs: Map<DocumentId, Y.Doc>,
      lockSnapshots: Map<DocumentId, ReturnType<typeof snapshotBlocks>>,
    ): Promise<T> => {
      const documentId = sorted[index];
      if (!documentId) return run(docs, lockSnapshots);
      return input.liveCoordinator.withDocument(
        documentId,
        async (doc) => {
          docs.set(documentId, doc);
          // LOCK-WS baseline must be captured synchronously when this live lock is acquired.
          lockSnapshots.set(
            documentId,
            snapshotBlocks(toDocHandle(doc), input.model, attributionCodec),
          );
          try {
            return await acquire(index + 1, docs, lockSnapshots);
          } finally {
            docs.delete(documentId);
            lockSnapshots.delete(documentId);
          }
        },
        { timeoutMs: 30_000, ...(signal ? { signal } : {}) },
      );
    };
    return acquire(0, new Map(), new Map());
  }

  function lateSweepNotice(
    documentId: DocumentId,
    before: ReturnType<typeof snapshotBlocks>,
    deletedParentHashes: ReadonlySet<string>,
    beforeContentRef: number | null,
    liveDoc: Y.Doc,
  ): NoticeInput | null {
    const after = snapshotBlocks(toDocHandle(liveDoc), input.model, attributionCodec);
    const diff = diffSnapshots(before, after);
    const affectedBlockHashes = [...deletedParentHashes]
      .filter((hash) => diff.changed.has(hash) || diff.deleted.has(hash))
      .sort();
    if (affectedBlockHashes.length === 0) return null;
    const postAwaitBodies = new Map(after.map((block) => [block.hash, block.serialized]));
    const preAwaitBodies = new Map(before.map((block) => [block.hash, block.serialized]));
    return {
      kind: "late_sweep",
      scope: { kind: "document", documentId },
      message: "Content was modified — View change",
      data: {
        documentId,
        affectedBlockHashes,
        capturedDeletedBodies: affectedBlockHashes.flatMap((hash) => {
          const body = postAwaitBodies.get(hash) ?? preAwaitBodies.get(hash);
          return body === undefined ? [] : [{ hash, body }];
        }),
        beforeContentRef,
      },
      writerVisible: true,
    };
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

        const locked = await withLiveDocumentLocks(
          [phase1.branch.documentId],
          inputPush.signal,
          async (docs, lockSnapshots) => {
            const liveDoc = docs.get(phase1.branch.documentId);
            if (!liveDoc) throw new Error("live push lock did not provide its document");
            const gated = await prepareUnderLiveLock(phase1, liveDoc);
            if (
              gated.conflictedBlocks.length > 0 &&
              inputPush.overlapPolicy !== "apply_and_trail"
            ) {
              return {
                kind: "result" as const,
                result: {
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
            const committed = await input.pushStore.commitPush({
              ...gated.prepared,
              pushedByUserId: inputPush.pushedByUserId,
              trail: durableTrailRecord({
                prepared: gated,
                documentTitle: trailDocumentName,
                swept,
              }),
            });
            if (committed.status === "conflict") {
              // The store checks idempotency and records lineage + trail in the same
              // transaction, so an existing push is necessarily already trailed.
              return {
                kind: "result" as const,
                result: {
                  status: "already_pushed" as const,
                  push: committed.push,
                  ...(phase1.conflictEcho ? { conflictEcho: phase1.conflictEcho } : {}),
                },
              };
            }
            await input.hooks?.afterDurableCommit?.([phase1.branch.documentId]);
            const lateNotice = lateSweepNotice(
              phase1.branch.documentId,
              lockSnapshots.get(phase1.branch.documentId) ?? [],
              gated.deletedParentHashes,
              gated.beforeContentRef,
              liveDoc,
            );
            // INVARIANT (LOCK-WS): final snapshot recheck and apply are synchronous; no await here.
            Y.applyUpdate(liveDoc, phase1.pushUpdate);
            if (lateNotice && input.notices)
              await recordLateNotice(lateNotice, {
                ...gated.prepared,
                trail: durableTrailRecord({ prepared: gated, documentTitle: trailDocumentName }),
              });
            return {
              kind: "committed" as const,
              committed: committed.push,
              liveAfterPush: Y.encodeStateAsUpdate(liveDoc),
              swept,
            };
          },
        );
        if (locked.kind === "result") return locked.result;

        const branchReset = await resetAutoBranchIfDrained(
          lease,
          phase1.branch,
          locked.liveAfterPush,
          inputPush.resetPolicy,
        );

        return {
          status: "pushed",
          push: locked.committed,
          update: phase1.pushUpdate,
          ...(phase1.conflictEcho ? { conflictEcho: phase1.conflictEcho } : {}),
          ...(branchReset ? { branchReset } : {}),
          ...(locked.swept ? { swept: locked.swept } : {}),
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
        const locked = await withLiveDocumentLocks(
          phases.map((phase) => phase.branch.documentId),
          inputPush.signal,
          async (docs, lockSnapshots) => {
            // One receipt identifies the entire companion transaction. Prepare trail
            // identities from that receipt rather than each phase's provisional ID.
            const receiptId = randomUUID();
            const gated = [];
            for (const [phaseIndex, phase] of phases.entries()) {
              const liveDoc = docs.get(phase.branch.documentId);
              if (!liveDoc) throw new Error("live batch push lock did not provide its document");
              const prepared = await prepareUnderLiveLock(phase, liveDoc, receiptId);
              if (
                prepared.conflictedBlocks.length > 0 &&
                (phaseIndex !== 0 || inputPush.overlapPolicy !== "apply_and_trail")
              ) {
                return {
                  kind: "conflict" as const,
                  conflict: {
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
            const pushes = gated.map((gatedPush, index) => ({
              ...gatedPush.prepared,
              receiptId,
              pushedByUserId: inputPush.pushedByUserId,
              trail: durableTrailRecord({
                prepared: gatedPush,
                documentTitle: titles[index] ?? "Untitled document",
                ...(index === 0 && swept ? { swept } : {}),
              }),
            }));
            const committed =
              pushes.length === 1
                ? {
                    pushes: [
                      (await input.pushStore.commitPush(pushes[0] as PreparedPushCommit)).push,
                    ],
                  }
                : await input.pushStore.commitPushBatch?.({ pushes });
            if (!committed) throw new Error("Branch push batch did not commit");
            await input.hooks?.afterDurableCommit?.(phases.map((phase) => phase.branch.documentId));
            for (const [index, phase] of phases.entries()) {
              const liveDoc = docs.get(phase.branch.documentId) as Y.Doc;
              const prepared = gated[index];
              if (!prepared) throw new Error("missing prepared push");
              const notice = lateSweepNotice(
                phase.branch.documentId,
                lockSnapshots.get(phase.branch.documentId) ?? [],
                prepared.deletedParentHashes,
                prepared.beforeContentRef,
                liveDoc,
              );
              // INVARIANT (LOCK-WS): final snapshot recheck and apply are synchronous; no await here.
              Y.applyUpdate(liveDoc, phase.pushUpdate);
              if (notice && input.notices) await recordLateNotice(notice, pushes);
            }
            return { kind: "committed" as const, committed, swept };
          },
        );
        if (locked.kind === "conflict") return locked.conflict;

        return {
          status: "pushed",
          push: locked.committed.pushes[0] as PushLineageRow,
          update: content.pushUpdate,
          ...(content.conflictEcho ? { conflictEcho: content.conflictEcho } : {}),
          ...(locked.swept ? { swept: locked.swept } : {}),
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
      return withLiveDocumentLocks(
        [phase1.branch.documentId],
        inputPush.signal,
        async (docs, lockSnapshots) => {
          const liveDoc = docs.get(phase1.branch.documentId);
          if (!liveDoc) throw new Error("live selective push lock did not provide its document");
          const gated = await prepareUnderLiveLock(phase1, liveDoc);
          if (gated.conflictedBlocks.length > 0) {
            return {
              status: "push_concurrent_conflict" as const,
              reason: "draft_base_divergence" as const,
              conflictedBlocks: gated.conflictedBlocks,
              conflicts: gated.conflicts,
            };
          }
          const committed = await input.pushStore.commitPush({
            ...gated.prepared,
            pushedByUserId: inputPush.pushedByUserId,
            trail: durableTrailRecord({
              prepared: gated,
              documentTitle: await resolveDocumentTitle(phase1.branch.documentId),
            }),
          });
          if (committed.status === "conflict")
            return { status: "already_pushed" as const, push: committed.push };
          await input.hooks?.afterDurableCommit?.([phase1.branch.documentId]);
          const notice = lateSweepNotice(
            phase1.branch.documentId,
            lockSnapshots.get(phase1.branch.documentId) ?? [],
            gated.deletedParentHashes,
            gated.beforeContentRef,
            liveDoc,
          );
          // INVARIANT (LOCK-WS): final snapshot recheck and apply are synchronous; no await here.
          Y.applyUpdate(liveDoc, phase1.pushUpdate);
          if (notice && input.notices)
            await recordLateNotice(notice, {
              ...gated.prepared,
              trail: durableTrailRecord({
                prepared: gated,
                documentTitle: await resolveDocumentTitle(phase1.branch.documentId),
              }),
            });
          return { status: "pushed" as const, push: committed.push, update: phase1.pushUpdate };
        },
      );
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
