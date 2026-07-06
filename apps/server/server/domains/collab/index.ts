/** Collab domain types and agent-edit-backed composition factories. */
import type { Hocuspocus } from "@hocuspocus/server";
import type { AgentEditCore, ConcurrentEditInfo } from "@meridian/agent-edit";
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
import type { DraftJournalSnapshot, DraftReviewPreview } from "./domain/draft-review-service.js";
import type {
  ActiveDraft,
  DraftAcceptResult,
  DraftLifecycleState,
  DraftRejectResult,
  DraftUndoDomainResult,
  ReviewableDraft,
} from "./domain/drafts.js";
import type { LiveLineageDocument, TurnEditedDocument } from "./domain/turn-live-lineage.js";

export type SchemaType = YjsTrackedSchemaType;

export type UpdateOrigin =
  | { type: "user"; userId: string }
  | { type: "agent"; actorTurnId: string }
  | { type: "import"; userId: string; source: string; filename: string; sourceId?: string }
  | { type: "system" };

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

export type CollabTransport = {
  bindHocuspocus(instance: Hocuspocus): void;
  resolveDraftHocuspocusRoom(
    draftId: string,
  ): Promise<{ draftId: string; documentId: DocumentId; status: "active" } | null>;
  resolveBranchHocuspocusRoom(branchId: string): Promise<{
    branchId: string;
    documentId: DocumentId;
    generation: number;
    status: "active";
  } | null>;
  loadHocuspocusDocument(documentId: DocumentId): Promise<Uint8Array | undefined>;
  loadHocuspocusDraft(draftId: string): Promise<Uint8Array | undefined>;
  loadHocuspocusBranch(branchId: string): Promise<Uint8Array | undefined>;
  loadHocuspocusBranchState(
    branchId: string,
  ): Promise<{ state: Uint8Array; generation: number } | undefined>;
  persistConnectionUpdate(input: {
    documentId: DocumentId;
    update: Uint8Array;
    origin: UpdateOrigin;
    document: Y.Doc;
  }): void;
  persistDraftConnectionUpdate(input: {
    draftId: string;
    update: Uint8Array;
    origin: UpdateOrigin;
    document: Y.Doc;
  }): void;
  persistBranchConnectionUpdate(input: {
    branchId: string;
    update: Uint8Array;
    origin: UpdateOrigin;
    document: Y.Doc;
    expectedGeneration?: number;
  }): void;
  storeHocuspocusDocument(documentId: DocumentId, document: Y.Doc): Promise<void>;
  storeHocuspocusDraft(draftId: string, document: Y.Doc): Promise<void>;
  storeHocuspocusBranch(branchId: string, document: Y.Doc): Promise<void>;
  drainHocuspocusPersistence(): Promise<void>;
  drainHocuspocusDraftPersistence(draftId: string): Promise<void>;
  drainHocuspocusBranchPersistence(branchId: string): Promise<void>;
  closeHocuspocusDraftRoom(draftId: string): void;
  closeHocuspocusBranchRoom(branchId: string): void;
  getPersistenceQueueMetrics(): CollabPersistenceMetrics;
};

export type WriteMode = "direct" | "draft";

export type AgentEditAccess = {
  agentEdit(): AgentEditCore;
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
  writeFromMarkdown(
    documentId: string,
    markdown: string,
    origin: UpdateOrigin,
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
  concurrentEdits?: ConcurrentEditInfo;
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
      status?: "committed";
      documents: ResponseWriteCommitDocument[];
      stagedCreates: ResponseWriteStagedCreates;
    }
  | DraftClosedFinalizeResult;

export type ResponseWriteRollbackFinalizeResult = {
  stagedCreates: ResponseWriteStagedCreates;
};

export type ResponseWriteFinalizer = {
  finalizeResponseCommit(
    responseId: string,
    ctx: { threadId: ThreadId; turnId: TurnId },
  ): Promise<ResponseWriteCommitFinalizeResult>;
  finalizeResponseRollback(responseId: string): Promise<ResponseWriteRollbackFinalizeResult>;
};

export type DocumentCheckpoints = {
  checkpoint(documentId: string, reason: string): Promise<Result<string, SyncError>>;
  restore(documentId: string, checkpointId: string): Promise<Result<void, SyncError>>;
  listCheckpoints(documentId: string): Promise<Result<CheckpointInfo[], SyncError>>;
};

export type DraftReviewApi = {
  list(input: { workId?: WorkId; threadId?: ThreadId }): Promise<ReviewableDraft[]>;
  preview(input: {
    workId?: WorkId;
    threadId?: ThreadId;
    documentId: DocumentId;
    draftId?: string;
  }): Promise<
    | ({ status: "active"; draftId?: string; branchId?: string } & DraftReviewPreview)
    | { status: "gone"; live: string }
  >;
  journal(input: {
    workId?: WorkId;
    threadId?: ThreadId;
    documentId: DocumentId;
    draftId: string;
  }): Promise<DraftJournalSnapshot | { status: "not_found" }>;
  accept(input: {
    projectId?: ProjectId;
    workId?: WorkId;
    threadId?: ThreadId;
    documentId: DocumentId;
    draftId?: string;
    branchId?: string;
    userId: UserId;
    confirmOverlap?: boolean;
    confirmedLiveRevisionToken?: number;
    draftRevisionToken?: number;
    operationIds?: string[];
    confirmedClosureOperationIds?: string[];
  }): Promise<DraftAcceptResult>;
  reject(input: {
    projectId?: ProjectId;
    workId?: WorkId;
    threadId?: ThreadId;
    documentId: DocumentId;
    draftId?: string;
    branchId?: string;
  }): Promise<DraftRejectResult>;
  undoAccept(input: {
    workId?: WorkId;
    threadId?: ThreadId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    writeId?: string;
  }): Promise<DraftUndoDomainResult>;
  undoReject(input: {
    workId?: WorkId;
    threadId?: ThreadId;
    documentId: DocumentId;
    draftId: string;
  }): Promise<DraftUndoDomainResult>;
};

export type DraftLifecycleFeed = {
  listLifecycleStateByWork(input: { workId: WorkId }): Promise<DraftLifecycleState[]>;
};

export type DraftSessionStats = {
  countInFlightDraftSessionsByWork(input: { workId: WorkId }): number;
  listActiveDraftsByWork(input: { workId: WorkId }): Promise<ActiveDraft[]>;
};

export type CollabDrafts = {
  draftReview: DraftReviewApi;
  draftLifecycleFeed: DraftLifecycleFeed;
  draftSessionStats: DraftSessionStats;
};

export type TurnLiveLineageAccess = {
  listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<LiveLineageDocument[]>;
  listEditedDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocument[]>;
};

export type BranchPushAccess = {
  pushToLive(input: { branchId: string; pushedByUserId?: UserId }): Promise<unknown>;
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
  pullThreadPeer(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
  flushBranchLivePull(documentId: DocumentId): Promise<void>;
  readEffectiveMarkdown(input: {
    documentId: DocumentId;
    threadId?: ThreadId | null;
  }): Promise<Result<string, SyncError>>;
  readEffectiveHashlines?(input: {
    documentId: DocumentId;
    threadId?: ThreadId | null;
  }): Promise<Result<string[], SyncError>>;
  resolveManifestMembership(input: {
    projectId: ProjectId;
    workId?: WorkId | null;
    threadId?: ThreadId | null;
  }): Promise<{ documentId: DocumentId; members: string[] }>;
  recordManifestDocumentCreated(
    documentId: DocumentId,
    view?: { projectId: ProjectId; workId?: WorkId | null; threadId?: ThreadId | null },
  ): Promise<void>;
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

export type CollabDomain = CollabTransport &
  AgentEditAccess &
  TurnReversalAccess &
  MarkdownDocumentStore &
  DocumentProjectionRefresher &
  TurnLiveLineageAccess &
  ResponseWriteFinalizer &
  DocumentCheckpoints &
  DocumentAttribution &
  BranchPushAccess &
  BranchPeerShadowAccess &
  CollabDrafts;

export { createCollabDomain, createInMemoryCollabDomain } from "./composition.js";
export {
  isStaleDocumentSchemaError,
  isStaleSchema,
  StaleDocumentSchemaError,
} from "./domain/stale-schema.js";
