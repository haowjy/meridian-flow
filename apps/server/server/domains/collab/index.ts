/** Collab domain types and agent-edit-backed composition factories. */
import type { Hocuspocus } from "@hocuspocus/server";
import type { AgentEditCore, ConcurrentEditInfo } from "@meridian/agent-edit";
import type {
  DraftReviewFallbackReason,
  ReviewHunk,
  ReviewOperation,
} from "@meridian/contracts/drafts";
import type { ReversalOutcome, YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { Result } from "../../shared/result.js";
import type {
  ActiveDraft,
  Draft,
  DraftAcceptResult,
  DraftRejectResult,
  DraftUndoDomainResult,
  ReviewableDraft,
} from "./domain/drafts.js";
import type { LiveLineageDocument } from "./domain/turn-live-lineage.js";

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
  loadHocuspocusDocument(documentId: DocumentId): Promise<Uint8Array | undefined>;
  loadHocuspocusDraft(draftId: string): Promise<Uint8Array | undefined>;
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
  storeHocuspocusDocument(documentId: DocumentId, document: Y.Doc): Promise<void>;
  storeHocuspocusDraft(draftId: string, document: Y.Doc): Promise<void>;
  drainHocuspocusPersistence(): Promise<void>;
  drainHocuspocusDraftPersistence(draftId: string): Promise<void>;
  closeHocuspocusDraftRoom(draftId: string): void;
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

export type ThreadWriteModeResolver = {
  resolveThreadWriteMode(threadId: ThreadId): Promise<WriteMode>;
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

export type CollabDrafts = {
  drafts: {
    getActiveDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
    getActiveDraftByWork(input: { documentId: DocumentId; workId: WorkId }): Promise<Draft | null>;
    resolveDraftThreadId(draftId: string): Promise<ThreadId | null>;
    listActiveDrafts(input: { threadId: ThreadId }): Promise<ActiveDraft[]>;
    listReviewableDrafts(input: { threadId: ThreadId }): Promise<ReviewableDraft[]>;
    listReviewableDraftsByWork(input: { workId: WorkId }): Promise<ReviewableDraft[]>;
    listActiveDraftsByWork(input: { workId: WorkId }): Promise<ActiveDraft[]>;
    countInFlightDraftSessionsByWork(input: { workId: WorkId }): number;
    buildDraftDoc(input: { documentId: DocumentId; draftId: string }): Promise<Y.Doc>;
    getDraftJournal(input: { documentId: DocumentId; draftId: string }): Promise<
      | {
          status: "active";
          draftRevisionToken: number;
          checkpoint: Uint8Array | null;
          updates: { seq: number; update: Uint8Array }[];
        }
      | { status: "not_found" }
    >;
    previewDraft(input: { documentId: DocumentId; draftId: string; surface?: "inline" }): Promise<{
      live: string;
      markdown: string;
      liveRevisionToken: number;
      draftRevisionToken: number;
      recommendedSurface: "inline" | "panel";
      fallbackReason?: DraftReviewFallbackReason;
      inlineModelPresent: boolean;
      operations?: ReviewOperation[];
      hunks?: ReviewHunk[];
    }>;
    acceptDraft(input: {
      documentId: DocumentId;
      threadId: ThreadId;
      draftId: string;
      userId: UserId;
      confirmOverlap?: boolean;
      confirmedLiveRevisionToken?: number;
      draftRevisionToken?: number;
    }): Promise<DraftAcceptResult>;
    rejectDraft(input: {
      documentId: DocumentId;
      threadId: ThreadId;
      draftId: string;
    }): Promise<DraftRejectResult>;
    undoAcceptDraft(input: {
      documentId: DocumentId;
      threadId: ThreadId;
      draftId: string;
      userId: UserId;
    }): Promise<DraftUndoDomainResult>;
    undoRejectDraft(input: {
      documentId: DocumentId;
      threadId: ThreadId;
      draftId: string;
    }): Promise<DraftUndoDomainResult>;
  };
};

export type TurnLiveLineageAccess = {
  listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<LiveLineageDocument[]>;
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
  ThreadWriteModeResolver &
  ResponseWriteFinalizer &
  DocumentCheckpoints &
  DocumentAttribution &
  CollabDrafts;

export { createCollabDomain, createInMemoryCollabDomain } from "./composition.js";
export {
  isStaleDocumentSchemaError,
  isStaleSchema,
  StaleDocumentSchemaError,
} from "./domain/stale-schema.js";
