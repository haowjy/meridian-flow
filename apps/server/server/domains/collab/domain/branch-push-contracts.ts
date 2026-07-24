/** Neutral branch-push contracts shared across collab domain services and adapters. */
import type {
  DocumentCoordinator,
  LineageRange,
  UpdateJournal,
  YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DraftApplyConflict } from "@meridian/contracts";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { MarkupCodec } from "@meridian/markup";
import type * as Y from "yjs";
import type { NoticePort } from "../../notices/index.js";
import type { BranchCoordinator, BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import type { BranchCriticalSections } from "./branch-critical-sections.js";
import type { DurableTrailRecord } from "./ports/change-trail-persistence.js";
import type { PendingSettlementStore } from "./ports/pending-settlement-store.js";
import type { WriterIngressBarrier } from "./ports/writer-ingress-barrier.js";
import type { ProvenanceRun } from "./provenance.js";
import type {
  NavigationTargetV1,
  NormalizedTrail,
  RawTrailChange,
  TrailChangeV1,
} from "./trail-read-kernel.js";

export class BranchPushCommitConflictError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} changed before its push could commit`);
    this.name = "BranchPushCommitConflictError";
  }
}

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

export type BranchJournalRow = {
  id: number;
  branchId: string;
  generation: number;
  wId: number | null;
  source: "agent" | "writer";
  threadId: ThreadId | null;
  turnId: TurnId | null;
  actorUserId: UserId | null;
  updateData: Uint8Array;
  /** Immutable live-journal watermark captured with this draft mutation. */
  draftBaseUpdateSeq: number;
  status: "active" | "pushed" | "discarded" | "rollback_pending";
  updateMeta?: unknown;
};

export function branchJournalRevision(
  rows: readonly Pick<BranchJournalRow, "id" | "status">[],
): string {
  return [...rows]
    .sort((left, right) => left.id - right.id)
    .map((row) => `${row.id}:${row.status}`)
    .join(",");
}

export function branchUpdateMetaWithReplacementScopes(
  updateMeta: unknown,
  replacementScopes: readonly (readonly LineageRange[])[],
  replacementScopesComplete: boolean,
): unknown {
  return {
    ...(isRecord(updateMeta) ? updateMeta : {}),
    replacementScopes: replacementScopes.map((scope) => scope.map((range) => ({ ...range }))),
    replacementScopesComplete,
  };
}

export function replacementScopesFromBranchRow(row: Pick<BranchJournalRow, "updateMeta">): {
  complete: boolean;
  scopes: LineageRange[][];
} {
  if (!isRecord(row.updateMeta) || !Array.isArray(row.updateMeta.replacementScopes)) {
    return { complete: false, scopes: [] };
  }
  return {
    complete: row.updateMeta.replacementScopesComplete === true,
    scopes: row.updateMeta.replacementScopes.flatMap((scope) =>
      Array.isArray(scope) && scope.length > 0 && scope.every(isLineageRange)
        ? [scope.map((range) => ({ ...range }))]
        : [],
    ),
  };
}

export type AutoBranchPushPort = {
  pushAutoBranchAfterThreadPeerWrite(input: {
    workDraftBranchId: string;
    pushedByUserId?: UserId;
  }): Promise<{ status: string; [key: string]: unknown }>;
};

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
  pushedByUserId?: UserId;
  /** Required participant in the atomic branch-push commit bundle. */
  trail: DurableTrailRecord;
  /** Crash-recoverable handoff guarding the post-commit LOCK-WS window. */
  pendingLiveSettlement: Omit<PendingLiveSettlement, "push">;
};

export type PreparedPush = {
  conflictedBlocks: string[];
  blindConflictedBlocks: string[];
  conflicts: DraftApplyConflict[];
  beforeContentRef: number | null;
  trailChanges: RawTrailChange[];
  lockCutUpdate: Uint8Array;
  prepared: Omit<
    PreparedPushCommit,
    "pushedByUserId" | "trail" | "pendingLiveSettlement" | "receiptId"
  > & { receiptId: string };
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
  joinVersion: number;
  settledJoinVersion: number | null;
  claim: SettlementClaim;
  attemptCount: number;
  state: "pending";
};

export type SettlementClaim = {
  token: string;
  epoch: number;
  kind: "warm" | "recovery";
  leaseExpiresAt: Date;
};

export type CompletionFenceResult = "applied" | "already_applied" | "retry";

type TrailContributionTarget = {
  owner: NormalizedTrail["owner"];
  classifications: readonly TrailChangeV1[];
};

export type TrailContributionReplacement = {
  targets: readonly TrailContributionTarget[];
  documentTitles: ReadonlyMap<string, string>;
} & ({ kind: "refine" } | { kind: "empty" });

export type PreparedDiscardCommit = {
  branch: BranchSnapshot;
  journalRows: BranchJournalRow[];
  state: Uint8Array;
  stateVector: Uint8Array;
  replacementUpdateData?: Uint8Array;
  replacementUpdateDataByJournalId?: ReadonlyMap<number, Uint8Array>;
  reviewedByUserId?: UserId;
};

export type PushCandidate = {
  branchId: string;
  documentId: DocumentId;
  rows: BranchJournalRow[];
  kind: "content" | "manifest";
  materialization: "whole" | "selected_rows";
  conflictPolicy: "refuse" | "apply_and_trail";
  sweepPolicy: "project" | "none";
};

export type CandidateBatch = {
  candidates: PushCandidate[];
  receiptId: string;
  resetPolicy?: "auto";
  pushedByUserId?: UserId;
};

export type BranchJournalReadStore = {
  listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
  listReviewableJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
  listConcurrentJournalRows(
    branchId: string,
    generation: number,
    options: { afterJournalId?: number; documentId: DocumentId },
  ): Promise<BranchJournalRow[]>;
  latestPushForBranch(branchId: string, generation: number): Promise<PushLineageRow | null>;
  listPushesForDocument(documentId: DocumentId): Promise<PushLineageRow[]>;
  listJournalRowsForTurn(input: {
    branchId?: string;
    generation?: number;
    threadId: ThreadId;
    turnId: TurnId;
    statuses?: readonly BranchJournalRow["status"][];
  }): Promise<BranchJournalRow[]>;
  listJournalRowsForBranch(input: {
    branchId: string;
    generation: number;
    throughJournalId?: number;
  }): Promise<BranchJournalRow[]>;
  listPushLineageForTurn(input: { threadId: ThreadId; turnId: TurnId }): Promise<PushLineageRow[]>;
};

export type PushCommitStore = {
  commitPush(
    input: PreparedPushCommit,
  ): Promise<
    { status: "inserted"; push: PushLineageRow } | { status: "conflict"; push: PushLineageRow }
  >;
  commitDiscard(input: PreparedDiscardCommit): Promise<void>;
  commitPushBatch(input: { pushes: PreparedPushCommit[] }): Promise<{
    pushes: PushLineageRow[];
  }>;
  commitTurnRedo(input: PreparedDiscardCommit): Promise<void>;
  markRollbackPending(input: {
    branchId: string;
    generation: number;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<number>;
};

export type WorkPushPolicyStore = {
  countUnpushedRowsForWork(workId: WorkId): Promise<number>;
  listActiveWorkDraftBranchIdsForWork(workId: WorkId): Promise<string[]>;
  updateWorkDraftPushPolicy(workId: WorkId, policy: "manual" | "auto"): Promise<void>;
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
    resetPolicy?: "auto";
  }): Promise<PushToLiveResult>;
  pushSelectedToLive(input: {
    branchId: string;
    journalIds: readonly number[];
    pushedByUserId?: UserId;
    signal?: AbortSignal;
  }): Promise<PushToLiveResult>;
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
};

export type BranchReviewService = {
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

export type BranchPushServiceInput = {
  branchStore: BranchStore;
  journalReadStore: BranchJournalReadStore;
  commitStore: PushCommitStore;
  workPushPolicyStore: WorkPushPolicyStore;
  settlementStore: PendingSettlementStore;
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
  writerIngressBarrier?: WriterIngressBarrier;
  hooks?: { afterDurableCommit?: (documentIds: readonly DocumentId[]) => Promise<void> };
};

function isLineageRange(value: unknown): value is LineageRange {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.clientID) &&
    Number.isSafeInteger(value.clock) &&
    Number.isSafeInteger(value.length) &&
    (value.clientID as number) >= 0 &&
    (value.clock as number) >= 0 &&
    (value.length as number) > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
