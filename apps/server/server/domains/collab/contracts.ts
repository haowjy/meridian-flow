/** Public contracts for the collab domain. */
import type { Hocuspocus } from "@hocuspocus/server";
import type {
  ConcurrentEditInfo,
  ResponseCommitWriteReceipt,
} from "@meridian/agent-edit/integration";
import type { TrailForwardActionResult } from "@meridian/contracts";
import type { ReversalOutcome, YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type {
  DocumentId,
  ProjectId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { Result } from "../../shared/result.js";
import type { ThreadPeerAgentEditCore } from "./domain/agent-edit-cores.js";
import type {
  ActiveDraft,
  DraftAcceptResult,
  DraftRejectResult,
  DraftReviewPreview,
  ReviewableDraft,
} from "./domain/branch-review.js";
import type { DocumentAuthorityHeads } from "./domain/ports/document-authority-heads.js";
import type { WriterIngressBarrier } from "./domain/ports/writer-ingress-barrier.js";
import type { LiveLineageDocument, TurnEditedDocument } from "./domain/turn-live-lineage.js";
import type { TurnReceiptChip } from "./domain/turn-receipt.js";

export type SchemaType = YjsTrackedSchemaType;

export type UpdateOrigin =
  | { type: "user"; userId: string }
  | { type: "agent"; actorTurnId: string }
  | { type: "import"; userId: string; source: string; filename: string; sourceId?: string }
  | { type: "system" };

export type DocumentSeedOrigin = Extract<UpdateOrigin, { type: "import" | "system" }>;

export type SyncError =
  | { code: "not_found"; documentId: string }
  | { code: "checkpoint_not_found"; checkpointId: string }
  | { code: "corrupt_state"; documentId: string; message: string };

export interface CheckpointInfo {
  id: string;
  reason: string;
  createdAt: string;
}

export type PersistedUpdate = {
  updateSeq: number;
  updateData: Uint8Array;
};

export type DocumentWriteOrigin =
  | { type: "agent"; actorTurnId: TurnId }
  | { type: "user"; actorUserId: UserId };

export type DocumentWriteResult = {
  documentId: DocumentId;
  markdown: string;
  updateSeq: number;
  updateData: Buffer;
  originType: DocumentWriteOrigin["type"];
  actorTurnId: TurnId | null;
  actorUserId: UserId | null;
};

export type DocumentWriteHook = (event: {
  documentId: DocumentId;
  threadId?: ThreadId;
  markdown: string;
  at: Date;
}) => Promise<void>;

export type CollabPersistenceMetrics = {
  queues: Array<{
    documentId: string;
    depth: number;
    oldestAgeMs: number;
    dropped: number;
  }>;
  liveDocumentCount: number;
  openConnectionCount: number;
};

export type AdmitLiveWriterUpdateResult =
  | { admitted: true; joinedSettlement: boolean }
  | { admitted: false; joinedSettlement: false };

export type CollabTransport = {
  bindHocuspocus(instance: Hocuspocus): void;
  resolveBranchHocuspocusRoom(
    branchId: string,
    generation: number,
  ): Promise<{
    branchId: string;
    documentId: DocumentId;
    generation: number;
    status: "active";
  } | null>;
  loadHocuspocusDocument(documentId: DocumentId): Promise<Uint8Array | undefined>;
  loadHocuspocusBranchState(
    branchId: string,
    generation: number,
  ): Promise<{ state: Uint8Array; generation: number } | undefined>;
  admitLiveWriterUpdate(input: {
    documentId: DocumentId;
    document: Y.Doc;
    update: Uint8Array;
    origin: Extract<UpdateOrigin, { type: "user" }>;
    expectedGeneration: bigint;
  }): Promise<AdmitLiveWriterUpdateResult>;
  currentLiveGeneration(documentId: DocumentId): Promise<bigint>;
  admitBranchWriterUpdate(input: {
    branchId: string;
    update: Uint8Array;
    origin: UpdateOrigin;
    document: Y.Doc;
    expectedGeneration: number;
  }): Promise<void>;
  writerIngressBarrier: WriterIngressBarrier;
  persistConnectionUpdate(input: {
    documentId: DocumentId;
    update: Uint8Array;
    origin: UpdateOrigin;
    document: Y.Doc;
    /** True only for the client's initial sync-step-2 integration. */
    reconcileOffline?: boolean;
  }): void;
  storeHocuspocusDocument(documentId: DocumentId, document: Y.Doc): Promise<void>;
  storeHocuspocusBranch(branchId: string, document: Y.Doc): Promise<void>;
  drainHocuspocusPersistence(): Promise<void>;
  drainHocuspocusBranchPersistence(branchId: string): Promise<void>;
  /** Narrow close affordance for durable shadow-probe T6 and branch reset plumbing. */
  closeHocuspocusBranchRoom(branchId: string): void;
  rejectStaleBranchSyncStep1(input: {
    branchId: string;
    generation: number;
    clientStateVector: Uint8Array;
  }): Promise<boolean>;
  getPersistenceQueueMetrics(): CollabPersistenceMetrics;
};

export type WriteMode = "direct" | "draft";

export type AgentEditAccess = {
  agentEdit(): ThreadPeerAgentEditCore;
};

export type TurnReversalAccess = {
  reverseTurn(input: {
    threadId: ThreadId;
    turnId: TurnId;
    direction: "undo" | "redo";
    actor: { type: "user"; userId: string } | { type: "agent" };
    documentIds?: DocumentId[];
  }): Promise<ReversalOutcome>;
};

export type MarkdownDocumentStore = {
  ensureDocument(documentId: string): Promise<void>;
  readAsMarkdown(documentId: string): Promise<Result<string, SyncError>>;
  seedFromMarkdown(
    documentId: string,
    markdown: string,
    origin: DocumentSeedOrigin,
  ): Promise<Result<PersistedUpdate | null, SyncError>>;
  writeDocument(input: {
    documentId: DocumentId;
    markdown: string;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult>;
  editDocument(input: {
    documentId: DocumentId;
    transform: (markdown: string) => string;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult & { beforeMarkdown: string }>;
};

export type DocumentProjectionRefresher = {
  refreshDocumentProjection(input: { documentId: DocumentId; threadId?: ThreadId }): Promise<void>;
};

export type ResponseWriteStagedCreates = {
  committed: DocumentId[];
  discarded: DocumentId[];
};

export type ResponseWriteCommitDocument = {
  documentId: DocumentId;
  updateCount: number;
  receipts: ResponseCommitWriteReceipt[];
  concurrentEdits?: ConcurrentEditInfo;
  lateSweep?: import("@meridian/agent-edit/integration").DestructiveSweepReport;
};

export type DraftClosedFinalizeResult = {
  status: "draft_closed";
  responseId: string;
  mode: "draft";
  documents: [];
  stagedCreates: ResponseWriteStagedCreates;
};

export type ResponseWriteCommitFinalizeResult =
  | {
      status: "committed";
      documents: ResponseWriteCommitDocument[];
      stagedCreates: ResponseWriteStagedCreates;
      awarenessDegraded?: boolean;
    }
  | DraftClosedFinalizeResult;

export type ResponseWriteRollbackFinalizeResult = {
  stagedCreates: ResponseWriteStagedCreates;
};

export type ResponseWriteFinalizer = {
  finalizeResponseCommit(
    responseId: string,
    ctx: { threadId: ThreadId; turnId: TurnId },
    beforeTransactionCommit?: (result: ResponseWriteCommitFinalizeResult) => Promise<void>,
  ): Promise<ResponseWriteCommitFinalizeResult>;
  finalizeResponseRollback(
    responseId: string,
    ctx: { threadId: ThreadId; turnId: TurnId },
  ): Promise<ResponseWriteRollbackFinalizeResult>;
};

export type DocumentCheckpoints = {
  checkpoint(documentId: string, reason: string): Promise<Result<string, SyncError>>;
  restore(documentId: string, checkpointId: string): Promise<Result<void, SyncError>>;
  listCheckpoints(documentId: string): Promise<Result<CheckpointInfo[], SyncError>>;
};

export type DraftReviewApi = {
  list(input: {
    projectId?: ProjectId;
    workId?: WorkId;
    threadId?: ThreadId;
  }): Promise<ReviewableDraft[]>;
  preview(input: {
    projectId?: ProjectId;
    workId?: WorkId;
    threadId?: ThreadId;
    documentId: DocumentId;
    draftId?: string;
  }): Promise<
    | ({ status: "active"; draftId?: string; branchId?: string } & DraftReviewPreview)
    | { status: "gone"; live: string }
  >;
  accept(input: {
    projectId?: ProjectId;
    workId?: WorkId;
    threadId?: ThreadId;
    documentId: DocumentId;
    draftId?: string;
    branchId?: string;
    userId: UserId;
    draftRevisionToken?: number;
    operationIds: string[];
    signal?: AbortSignal;
  }): Promise<DraftAcceptResult>;
  reject(input: {
    projectId?: ProjectId;
    workId?: WorkId;
    threadId?: ThreadId;
    documentId: DocumentId;
    draftId?: string;
    branchId?: string;
    userId?: UserId;
    operationIds?: string[];
  }): Promise<DraftRejectResult>;
};

export type DraftSessionStats = {
  listActiveDraftsByWork(input: { workId: WorkId }): Promise<ActiveDraft[]>;
};

export type CollabDrafts = {
  draftReview: DraftReviewApi;
  draftSessionStats: DraftSessionStats;
};

export type TurnLiveLineageAccess = {
  listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<LiveLineageDocument[]>;
  listEditedDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocument[]>;
  getTurnReceiptChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
};

export type BranchPushAccess = {
  recoverPendingLiveSettlements(input?: { signal?: AbortSignal }): Promise<number>;
  pushToLive(input: { branchId: string; pushedByUserId?: UserId }): Promise<unknown>;
  pushSelectedToLive(input: {
    branchId: string;
    journalIds: readonly number[];
    pushedByUserId?: UserId;
  }): Promise<unknown>;
  countUnpushedRowsForWork(workId: WorkId): Promise<number>;
  setWorkPushPolicy(input: {
    workId: WorkId;
    policy: "manual" | "auto";
    confirmedPush?: boolean;
    pushedByUserId?: UserId;
  }): Promise<unknown>;
  markFailedResponseRollbackPending(input: {
    branchId: string;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<unknown>;
};

export type BranchPeerShadowAccess = {
  pullThreadPeer(input: { documentId: DocumentId; threadId: ThreadId }): Promise<unknown>;
  flushBranchLivePull(documentId: DocumentId): Promise<void>;
  readEffectiveMarkdown(input: {
    documentId: DocumentId;
    threadId?: ThreadId | null;
    responseId?: string | null;
  }): Promise<Result<string, SyncError>>;
  readEffectiveHashlines?(input: {
    documentId: DocumentId;
    threadId?: ThreadId | null;
    responseId?: string | null;
  }): Promise<Result<string[], SyncError>>;
  resolveManifestMembership(input: {
    projectId: ProjectId;
    workId?: WorkId | null;
    threadId?: ThreadId | null;
    responseId?: string | null;
  }): Promise<{ documentId: DocumentId; members: string[] }>;
  reconcileProjectManifest(projectId: ProjectId): Promise<void>;
  recordManifestDocumentCreated(
    documentId: DocumentId,
    view?: { projectId: ProjectId; workId?: WorkId | null; threadId?: ThreadId | null },
  ): Promise<void>;
  /** The documents.deleted_at transaction must commit before this notification. */
  recordManifestDocumentDeleted(
    documentId: DocumentId,
    view?: { projectId: ProjectId; workId?: WorkId | null; threadId?: ThreadId | null },
  ): Promise<void>;
};

export type DocumentAttribution = {
  getLastUpdateAttribution(documentId: DocumentId): Promise<{
    originType: string | null;
    actorTurnId: TurnId | null;
    actorUserId: UserId | null;
    updateSeq: number | null;
  }>;
};

export type TrailForwardActionAccess = {
  applyTrailForwardAction(input: {
    threadId: ThreadId;
    trailId: string;
    changeId: string;
    action: "restore" | "delete-again";
    userId: UserId;
  }): Promise<TrailForwardActionResult>;
};

export type CollabDomain = CollabTransport &
  DocumentAuthorityHeads &
  AgentEditAccess &
  TurnReversalAccess &
  MarkdownDocumentStore &
  DocumentProjectionRefresher &
  TurnLiveLineageAccess &
  ResponseWriteFinalizer &
  DocumentCheckpoints &
  DocumentAttribution &
  TrailForwardActionAccess &
  BranchPushAccess &
  BranchPeerShadowAccess &
  CollabDrafts;

export type {
  DocumentAuthorityHead,
  DocumentAuthorityHeads,
} from "./domain/ports/document-authority-heads.js";
