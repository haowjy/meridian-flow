/** Neutral branch-push contracts shared across collab domain services and adapters. */

import type {
  DocumentCoordinator,
  UpdateJournal,
  YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { PendingChangesChoice } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { MarkupCodec } from "@meridian/markup";
import type * as Y from "yjs";
import type { BranchCoordinator, BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import type { BranchCriticalSections } from "./branch-critical-sections.js";
import type { ChangeEventDelivery } from "./ports/change-event-delivery.js";
import type { DurableTrailRecord } from "./ports/change-trail-persistence.js";
import type { DocumentAssetPaths } from "./ports/document-asset-paths.js";
import type { PendingSettlementStore } from "./ports/pending-settlement-store.js";
import type { WorkDraftPendingStore } from "./ports/work-draft-pending-store.js";
import type { WriterIngressBarrier } from "./ports/writer-ingress-barrier.js";
import type { SweepEvidence } from "./sweep-policy.js";
import type { NormalizedTrail, RawTrailChange, TrailChangeV1 } from "./trail-read-kernel.js";

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

export type PublicationBlockChange = {
  blockId: string;
  beforeText: string | null;
  afterText: string | null;
};

export type PushLineageRow = {
  id: number;
  branchId: string | null;
  branchGeneration: number;
  documentId: DocumentId;
  journalIds: number[];
  upstreamUpdateSeq: number | null;
  idempotencyKey: string;
  receiptId?: string | null;
  threadId?: ThreadId | null;
  turnId?: TurnId | null;
};

export type PushToLiveResult =
  | {
      status: "pushed";
      push: PushLineageRow;
      update: Uint8Array;
      branchReset?: { branchId: string; fromGeneration: number };
    }
  | { status: "already_pushed"; push: PushLineageRow }
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
  idempotencyKey: string;
  receiptId?: string;
  pushedByUserId?: UserId;
  /** Required participant in the atomic branch-push commit bundle. */
  trail: DurableTrailRecord;
  /** Crash-recoverable handoff guarding the post-commit LOCK-WS window. */
  pendingLiveSettlement: Omit<PendingLiveSettlement, "push">;
};

export type PreparedPush = {
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
  trail: DurableTrailRecord;
  /** Optional evidence for live-session sweep elevation; never settlement authority. */
  sweepEvidence: SweepEvidence | null;
  joinVersion: number;
  settledJoinVersion: number | null;
  claim: SettlementClaim;
  attemptCount: number;
  state: "pending";
};

export type SweepProjectionDiagnostics = {
  unavailable(input: { pushId: number; documentId: DocumentId; cause: unknown }): void;
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
  changes: readonly TrailChangeV1[];
};

export type TrailContributionReplacement = {
  targets: readonly TrailContributionTarget[];
  documentTitles: ReadonlyMap<string, string>;
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

export type PushCandidate = {
  branchId: string;
  documentId: DocumentId;
  rows: BranchJournalRow[];
  /** Content publishes whole-branch state; manifest publishes only the selected membership rows. */
  kind: "content" | "manifest";
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
  /**
   * Seam B for a review that changes several drafts in one transaction: locks
   * their Works (file-access §5) and names the branches whose Work is no longer
   * active, so their drafts stay frozen (D30).
   */
  lockDraftWorks(branchIds: readonly string[]): Promise<ReadonlySet<string>>;
  markRollbackPending(input: {
    branchId: string;
    generation: number;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<number>;
};

export type WorkPushPolicyStore = {
  /** Sets the Work's AI write mode: `auto` is auto-apply, `manual` is draft mode. */
  setWorkWriteMode(workId: WorkId, policy: "manual" | "auto"): Promise<void>;
};

export type PushUpdateComputer = (input: {
  branch: BranchSnapshot;
  branchDoc: Y.Doc;
  liveDoc: Y.Doc;
}) => Uint8Array;

export type BranchPushService = {
  recoverPendingLiveSettlements(input?: { signal?: AbortSignal }): Promise<number>;
  pushToLive(input: {
    branchId: string;
    pushedByUserId?: UserId;
    signal?: AbortSignal;
    resetPolicy?: "auto";
  }): Promise<PushToLiveResult>;
  pushToLiveWithManifestEntry(input: {
    branchId: string;
    manifestBranchId: string;
    manifestEntryDocumentId: DocumentId;
    pushedByUserId?: UserId;
    signal?: AbortSignal;
    resetPolicy?: "auto";
  }): Promise<PushToLiveResult>;
  setWorkPushPolicy(input: SetWorkPushPolicyInput): Promise<SetWorkPushPolicyResult>;
};

export type SetWorkPushPolicyInput = {
  workId: WorkId;
  policy: "manual" | "auto";
  /** Required to switch to auto-apply while drafts have pending changes. */
  pending?: PendingChangesChoice;
  pushedByUserId?: UserId;
};

export type SetWorkPushPolicyResult =
  | { status: "updated"; policy: "manual" | "auto" }
  | { status: "confirmation_required"; unpushedCount: number; reason: string };

export type BranchTurnReversal =
  | { status: "reversed" | "reconciled"; branchId: string; journalIds: number[] }
  | {
      status: "cant_undo_dependent" | "nothing_to_undo" | "nothing_to_redo" | "permission_denied";
      branchId: string;
      journalIds: number[];
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
  /** Reverses one turn on each branch; a branch whose Work is archived is refused. */
  reverseBranchTurns(input: {
    branchIds: readonly string[];
    threadId: ThreadId;
    turnId: TurnId;
    direction: "undo" | "redo";
    reviewedByUserId?: UserId;
  }): Promise<BranchTurnReversal[]>;
  markFailedResponseRollbackPending(input: {
    branchId: string;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<
    | { status: "discarded"; branchId: string; journalIds: number[] }
    | { status: "rollback_pending"; rowsMarked: number }
  >;
};

export type BranchPushServiceInput = {
  branchStore: BranchStore;
  journalReadStore: BranchJournalReadStore;
  commitStore: PushCommitStore;
  workPushPolicyStore: WorkPushPolicyStore;
  workDraftPendingStore: WorkDraftPendingStore;
  settlementStore: PendingSettlementStore;
  branchCoordinator?: Pick<BranchCoordinator, "resetFromDocIfUnchangedWithLease"> &
    Partial<Pick<BranchCoordinator, "broadcastUpdate">>;
  journal: UpdateJournal;
  liveCoordinator: DocumentCoordinator;
  model: YProsemirrorDocumentModel;
  codec: MarkupCodec;
  assetPaths: DocumentAssetPaths;
  changeEventDelivery: ChangeEventDelivery;
  pushUpdateComputer?: PushUpdateComputer;
  criticalSections?: BranchCriticalSections;
  resolveDocumentTitle?: (documentId: DocumentId) => Promise<string | null>;
  writerIngressBarrier?: WriterIngressBarrier;
  sweepProjectionDiagnostics?: SweepProjectionDiagnostics;
  hooks?: { afterDurableCommit?: (documentIds: readonly DocumentId[]) => Promise<void> };
};
