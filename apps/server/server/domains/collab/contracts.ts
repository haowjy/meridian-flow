/** Public contracts for the collab domain. */
import type { Hocuspocus, Document as HocuspocusDocument } from "@hocuspocus/server";
import type {
  ConcurrentEditInfo,
  ResponseCommitWriteReceipt,
} from "@meridian/agent-edit/integration";
import type { BranchId, LinkView } from "@meridian/contracts";
import type { BranchCommandResult } from "@meridian/contracts/branches";
import type { ReversalOutcome, TurnReceiptChip } from "@meridian/contracts/protocol";
import type {
  DocumentId,
  ProjectId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import type { SpelledLinkFact } from "@meridian/markup/links";
import type { CollabSchemaVersion } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import type { Result } from "../../shared/result.js";
import type { WorkBranchDisposal } from "../projects/index.js";
import type {
  FrontierLookup,
  RefusedResponseDocument,
  RoomObservation,
  RoutedOutcome,
  RoutedWriteOutcome,
  ThreadPeerAgentEditCore,
} from "./domain/agent-edit-cores.js";

export type {
  FrontierLookup,
  RefusedResponseDocument,
  RoomObservation,
  RoutedOutcome,
  RoutedWriteOutcome,
};

import type { ApplyItemRef } from "./domain/branch-apply.js";
import type {
  BranchCommandEnvelope,
  CommandLookup,
  CommandLookupKey,
} from "./domain/branch-commands.js";
import type { ResolvedReviewItem } from "./domain/branch-review-identity.js";
import type { DraftReviewItem } from "./domain/branch-review-items.js";
import type { Branches } from "./domain/branches.js";
import type { DocumentCreationAggregate } from "./domain/document-creation.js";
import type { DraftAheadRegistration } from "./domain/draft-ahead-registration.js";
import type { BoundWrite, LinkBinder } from "./domain/link-binding.js";
import type { DocumentAuthorityHeads } from "./domain/ports/document-authority-heads.js";
import type { DocumentBranchOrigin } from "./domain/ports/work-branch-pending-store.js";
import type { WriterIngressBarrier } from "./domain/ports/writer-ingress-barrier.js";
import type { DerivedReview } from "./domain/review-cut.js";
import type { LiveLineageDocument, TurnEditedDocument } from "./domain/turn-live-lineage.js";

export type UpdateOrigin =
  | { type: "user"; userId: string }
  | { type: "agent"; actorTurnId: string }
  | { type: "import"; userId: string; source: string; filename: string; sourceId?: string }
  | { type: "system" };

export type DocumentSeedOrigin = Extract<UpdateOrigin, { type: "import" | "system" }>;

export type SyncError =
  | { code: "stale_generation"; documentId: string }
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

/** A live document under the coordinator lease its caller holds (contract §6.3 B3). */
export type HeldLiveDocument = { documentId: DocumentId; doc: Y.Doc };
/** The creation-bound content is admitted only for this document at this address. */
export type HeldWriteExpectation = { documentId: DocumentId; uri: string };
export type HeldWriteStaged = { markdown: string; updateSeq: number };

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
  primeReservedNamespaceIndex(document: Y.Doc): void;
  headSchemaVersion(documentId: DocumentId): Promise<CollabSchemaVersion | null>;
  resolveDraftHocuspocusRoom(
    draftId: string,
    generation: number,
  ): Promise<{
    draftId: string;
    documentId: DocumentId;
    /** The Work whose draft the room is; its lifecycle caps the room's access. */
    workId: WorkId;
    generation: number;
    schemaVersion: CollabSchemaVersion;
    status: "active";
  } | null>;
  loadHocuspocusDocument(documentId: DocumentId, document?: Y.Doc): Promise<Uint8Array | undefined>;
  loadHocuspocusDraftState(
    draftId: string,
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
  validateHocuspocusDocument(documentId: DocumentId, document: Y.Doc): Promise<void>;
  admitDraftWriterUpdate(input: {
    draftId: string;
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
  storeHocuspocusDraft(draftId: string, document: Y.Doc): Promise<void>;
  drainHocuspocusPersistence(): Promise<void>;
  drainHocuspocusDraftPersistence(draftId: string): Promise<void>;
  /** Narrow close affordance for durable shadow-probe T6 and draft reset plumbing. */
  closeHocuspocusDraftRoom(draftId: string): void;
  /**
   * A tab's SyncStep1 on a draft room: reconciles `room` against the committed draft, then
   * true when the tab still holds content a reset discarded (decision D27).
   */
  rejectStaleDraftSyncStep1(input: {
    draftId: string;
    generation: number;
    clientStateVector: Uint8Array;
    room: Y.Doc;
  }): Promise<boolean>;
  /**
   * Called from a draft room's load hook: once Hocuspocus registers the room, brings it up to
   * what committed while it loaded, or closes it when its generation is stale (decision D26).
   */
  enrollHocuspocusDraftRoom(input: {
    draftId: string;
    generation: number;
    document: HocuspocusDocument;
  }): void;
  getPersistenceQueueMetrics(): CollabPersistenceMetrics;
};

export type AgentEditAccess = {
  /** The one model read/write entry point; each call names its destination. */
  agentEdit(): ThreadPeerAgentEditCore;
};

export type ReverseThreadContextInput = {
  threadId: ThreadId;
  userId: UserId;
  direction: "undo" | "redo";
  turnId: TurnId;
};

export type TurnReversalAccess = {
  reverseTurn(input: {
    threadId: ThreadId;
    turnId: TurnId;
    direction: "undo" | "redo";
    actor: { type: "user"; userId: string } | { type: "agent" };
    documentIds?: DocumentId[];
  }): Promise<ReversalOutcome>;
  reverseThreadContext(input: ReverseThreadContextInput): Promise<ReversalOutcome>;
};

export type VersionedDocumentRead<T> = { content: T; revision: string | null };

export type HashlineRead = VersionedDocumentRead<string[]> & {
  /** Aligned with `content`: the ref-bearing links each block spells. */
  links: readonly (readonly SpelledLinkFact[])[];
  /** The holder `links` were spelled from, as the read's own binding named it. */
  holder: { uri: string | null; view: LinkView };
};

/**
 * Whole-document reads and writes. Writes take `BoundWrite`: bind it with
 * `bindMarkdown` before opening any transaction, then apply it inside one
 * (contract §6.2).
 */
export type MarkdownDocumentStore = LinkBinder & {
  readVersionedMarkdown(
    documentId: string,
  ): Promise<Result<VersionedDocumentRead<string>, SyncError>>;
  ensureDocument(documentId: string): Promise<void>;
  readAsMarkdown(documentId: string): Promise<Result<string, SyncError>>;
  /** Writes only a document with no state yet; otherwise a no-op. */
  seedFromMarkdown(
    documentId: string,
    content: BoundWrite,
    origin: DocumentSeedOrigin,
  ): Promise<Result<PersistedUpdate | null, SyncError>>;
  writeDocument(input: {
    documentId: DocumentId;
    content: BoundWrite;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult>;
  /**
   * The live coordinator's lease on a document, taken outside any transaction (contract
   * §6.3 B3): a revealed document's first content is admitted under it.
   */
  withLiveDocument<T>(
    documentId: string,
    operation: (held: HeldLiveDocument) => Promise<T>,
  ): Promise<T>;
  /**
   * A revealed document's first content, under a lease the caller holds and inside its
   * transaction: verifies identity and address, stages on a clone, journals durably, and
   * applies to the warm document only after commit.
   */
  writeDocumentHeld(input: {
    held: HeldLiveDocument;
    content: BoundWrite;
    expected: HeldWriteExpectation;
    origin: DocumentWriteOrigin | DocumentSeedOrigin;
    threadId?: ThreadId;
  }): Promise<Result<HeldWriteStaged, SyncError>>;
};

export type DocumentProjectionRefresher = {
  documentDerivations: import("./domain/ports/document-derivations.js").DocumentDerivationService;
  /** One pass of the draft-effect projection's sweep over stale drafts (design §3.2). */
  draftEffects: { sweep(): Promise<number>; flush(): Promise<void> };
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
  /** Host-only: the document's frontier at the post-commit cut, when the save recorded one. */
  frontiers?: RoomObservation[];
};

export type BranchClosedFinalizeResult = {
  status: "branch_closed";
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
      /** Documents the save left out (D29); their writes were not saved. */
      refused: RefusedResponseDocument[];
      awarenessDegraded?: boolean;
    }
  | BranchClosedFinalizeResult;

export type ResponseWriteRollbackFinalizeResult = {
  stagedCreates: ResponseWriteStagedCreates;
};

export type ResponseWriteFinalizer = {
  finalizeResponseCommit(
    responseIdentity: import("@meridian/contracts").ModelResponseIdentity,
    ctx: { threadId: ThreadId; turnId: TurnId; recordingFrontier?: FrontierLookup },
    beforeTransactionCommit?: (result: ResponseWriteCommitFinalizeResult) => Promise<void>,
  ): Promise<ResponseWriteCommitFinalizeResult>;
  finalizeResponseRollback(
    responseIdentity: import("@meridian/contracts").ModelResponseIdentity,
    ctx: { threadId: ThreadId; turnId: TurnId },
  ): Promise<ResponseWriteRollbackFinalizeResult>;
};

export type DocumentCheckpoints = {
  checkpoint(documentId: string, reason: string): Promise<Result<string, SyncError>>;
  restore(documentId: string, checkpointId: string): Promise<Result<void, SyncError>>;
  listCheckpoints(documentId: string): Promise<Result<CheckpointInfo[], SyncError>>;
};

/** What per-change Apply and Discard say they selected, and the tokens that fence it (§4.1). */
export type ReviewSelectionCommand =
  | {
      kind: "apply";
      operationIds: readonly string[];
      liveRevisionToken: string;
      draftRevisionToken: string;
    }
  | {
      kind: "discard";
      closureClassIds: readonly string[];
      admissionTokens: readonly string[];
      memberPartKeys: readonly string[];
      /** False when the client sent a sample: absence then proves nothing. */
      memberPartKeysComplete: boolean;
      liveRevisionToken: string;
      draftRevisionToken?: string;
    };

/**
 * A writer command's answer (§4.6): the stored wire body, still pending, blocked, or the id
 * belongs to a different command. The route maps these to HTTP.
 */
export type CommandOutcome =
  | { kind: "result"; result: BranchCommandResult }
  | { kind: "pending" }
  | { kind: "blocked" }
  | { kind: "conflict" };

/** The model-facing list row: which documents have a draft, nothing more. */
export type ModelDraftRow = {
  documentId: DocumentId;
  documentName: string | null;
  contextLocation: import("@meridian/contracts/branches").ThreadDraftListItem["contextLocation"];
  createdDocument?: boolean;
};

export type DraftPreviewResult =
  | (DerivedReview & { threadTitles: ReadonlyMap<string, string> })
  | { status: "gone"; itemKey: string }
  | { status: "corrupt"; branchId: BranchId; itemKey: string; draftGeneration: number };

export type DraftReviewApi = {
  list(input: { projectId?: ProjectId; workId: WorkId }): Promise<ModelDraftRow[]>;
  /** The review list route's one read: the active branch's listed items with live text tokens. */
  listItems(input: { workId: WorkId }): Promise<{
    branchId: BranchId | null;
    items: DraftReviewItem[];
    threadTitles: ReadonlyMap<string, string>;
  }>;
  /** Every active branch in the project with changes to the document, oldest first. */
  branchesChangingDocument(input: {
    projectId: ProjectId;
    documentId: DocumentId;
  }): Promise<DocumentBranchOrigin[]>;
  /** The Work's active branch's listed items, live text tokens unread: what Apply authorizes. */
  items(input: {
    workId: WorkId;
  }): Promise<{ branchId: BranchId | null; items: DraftReviewItem[] }>;
  resolveItem(input: { workId: WorkId; itemKey: string }): Promise<ResolvedReviewItem | null>;
  resolveItemByDocument(input: {
    workId: WorkId;
    documentId: DocumentId;
  }): Promise<ResolvedReviewItem | null>;
  preview(input: { workId: WorkId; itemKey: string }): Promise<DraftPreviewResult>;
  lookupCommand(key: CommandLookupKey): Promise<CommandLookup>;
  applyItem(input: {
    workId: WorkId;
    item: DraftReviewItem;
    userId: UserId;
    envelope: BranchCommandEnvelope;
    tokens?: Omit<ApplyItemRef, "itemKey">;
    signal?: AbortSignal;
  }): Promise<CommandOutcome>;
  applyAll(input: {
    workId: WorkId;
    branchId: BranchId;
    items: readonly ApplyItemRef[];
    userId: UserId;
    envelope: BranchCommandEnvelope;
    signal?: AbortSignal;
  }): Promise<CommandOutcome>;
  applyChanges(input: {
    workId: WorkId;
    itemKey: string;
    userId: UserId;
    envelope: BranchCommandEnvelope;
    selection: Extract<ReviewSelectionCommand, { kind: "apply" }>;
    signal?: AbortSignal;
  }): Promise<CommandOutcome>;
  discardItem(input: {
    workId: WorkId;
    item: DraftReviewItem;
    userId: UserId;
    envelope: BranchCommandEnvelope;
  }): Promise<CommandOutcome>;
  discardChanges(input: {
    workId: WorkId;
    itemKey: string;
    userId: UserId;
    envelope: BranchCommandEnvelope;
    selection: Extract<ReviewSelectionCommand, { kind: "discard" }>;
  }): Promise<CommandOutcome>;
  discardAll(input: {
    workId: WorkId;
    branchId: BranchId;
    userId: UserId;
    envelope: BranchCommandEnvelope;
  }): Promise<CommandOutcome>;
};

export type CollabBranches = {
  draftReview: DraftReviewApi;
};

/** The one branch resolver (Work → active branch, made only at the write boundary). */
export type CollabBranchResolver = {
  branches: Branches;
  /** A drain for the debounced registration of writers' review-room edits (§10.7). */
  draftLinks: Pick<DraftAheadRegistration, "flush">;
  /** Work purge's disposal of the purged Work's branches through the locked Discard kernel (§2.6). */
  workBranchDisposal: WorkBranchDisposal;
};

export type TurnLiveLineageAccess = {
  listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<LiveLineageDocument[]>;
  listEditedDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocument[]>;
  getTurnReceiptChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
};

export type BranchPushAccess = {
  recoverPendingLiveSettlements(input?: { signal?: AbortSignal }): Promise<number>;
};

/**
 * The version an effective read reads, and so the view its links spell in:
 * the version the caller's writes change. `live` never touches a draft (D40);
 * a draft read names its Work.
 */
export type EffectiveReadVersion =
  | { destination: "live"; workId?: never }
  | { destination: "draft"; workId: WorkId };

export type DraftPeerShadowAccess = {
  readEffectiveRevision(
    input: {
      documentId: DocumentId;
      /** The reading thread: its peer and its reply's staged writes count. */
      threadId?: ThreadId | null;
    } & EffectiveReadVersion,
  ): Promise<string | null>;
  flushDraftLivePull(documentId: DocumentId): Promise<void>;
  readEffectiveMarkdown(
    input: {
      documentId: DocumentId;
      threadId?: ThreadId | null;
      responseId?: string | null;
    } & EffectiveReadVersion,
  ): Promise<Result<VersionedDocumentRead<string>, SyncError>>;
  /**
   * One hashline per block, and per block the ref-bearing links it spells
   * (`spelledLinks`), computed with the same scope in the same synchronous block.
   */
  readEffectiveHashlines(
    input: {
      documentId: DocumentId;
      threadId?: ThreadId | null;
      responseId?: string | null;
    } & EffectiveReadVersion,
  ): Promise<Result<HashlineRead, SyncError>>;
  /**
   * The branch's draft for a document it just created or joined, seeded from its live
   * document (empty: a draft create never seeds live Yjs), in the caller's transaction;
   * idempotent against a racing peer ensure (contract §6.2 step 5).
   */
  ensureCreatedDocumentDraft(input: { documentId: DocumentId; branchId: BranchId }): Promise<void>;
  /**
   * Reverse a branch create's draft (contract §12.5, O-11), in the caller's transaction:
   * `stands` when the branch's draft on the document (or a thread peer of it) holds a
   * contribution; otherwise the drafts go and, once the transaction commits, their
   * pooled cores, caches and rooms are retired.
   */
  retractCreatedDocumentDraft(input: {
    documentId: DocumentId;
    branchId: BranchId;
  }): Promise<"retracted" | "stands">;
};

export type DocumentAttribution = {
  getLastUpdateAttribution(documentId: DocumentId): Promise<{
    originType: string | null;
    actorTurnId: TurnId | null;
    actorUserId: UserId | null;
    updateSeq: number | null;
  }>;
};

/** Background work the domain schedules itself, stopped when the app shuts down. */
export type CollabLifecycle = {
  /**
   * Drops debounced live-to-draft pulls and projection runs that haven't started; running
   * ones finish.
   */
  dispose(): void;
};

export type CollabDomain = CollabTransport &
  CollabLifecycle &
  DocumentAuthorityHeads &
  AgentEditAccess &
  TurnReversalAccess &
  MarkdownDocumentStore &
  DocumentProjectionRefresher &
  TurnLiveLineageAccess &
  ResponseWriteFinalizer &
  DocumentCheckpoints &
  DocumentAttribution &
  BranchPushAccess &
  DraftPeerShadowAccess &
  CollabBranches &
  CollabBranchResolver &
  DocumentCreationAggregate;

export type { DocumentCreationAggregate } from "./domain/document-creation.js";
export type {
  DocumentAuthorityHead,
  DocumentAuthorityHeads,
} from "./domain/ports/document-authority-heads.js";
