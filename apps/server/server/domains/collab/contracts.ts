/** Public contracts for the collab domain. */
import type { Hocuspocus } from "@hocuspocus/server";
import type {
  ConcurrentEditInfo,
  ResponseCommitWriteReceipt,
} from "@meridian/agent-edit/integration";
import type { DraftId, LinkView } from "@meridian/contracts";
import type { DraftCommandResult } from "@meridian/contracts/drafts";
import type { ReversalOutcome } from "@meridian/contracts/protocol";
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
import type { WorkDraftDisposal } from "../projects/index.js";
import type {
  RefusedResponseDocument,
  RoutedWriteOutcome,
  ThreadPeerAgentEditCore,
} from "./domain/agent-edit-cores.js";

export type { RefusedResponseDocument, RoutedWriteOutcome };

import type { DocumentCreationAggregate } from "./domain/document-creation.js";
import type { DraftBranchAheadRegistration } from "./domain/draft-branch-ahead-registration.js";
import type { DraftBranchLeases } from "./domain/draft-branch-leases.js";
import type {
  CommandLookup,
  CommandLookupKey,
  DraftCommandEnvelope,
} from "./domain/draft-commands.js";
import type { ApplyItemRef } from "./domain/draft-publication.js";
import type { ResolvedReviewItem } from "./domain/draft-review-identity.js";
import type { DraftReviewItem } from "./domain/draft-review-items.js";
import type { Drafts } from "./domain/drafts.js";
import type { BoundWrite, LinkBinder } from "./domain/link-binding.js";
import type { DocumentAuthorityHeads } from "./domain/ports/document-authority-heads.js";
import type { WriterIngressBarrier } from "./domain/ports/writer-ingress-barrier.js";
import type { DerivedReview } from "./domain/review-cut.js";
import type { LiveLineageDocument, TurnEditedDocument } from "./domain/turn-live-lineage.js";
import type { TurnReceiptChip } from "./domain/turn-receipt.js";

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
  resolveBranchHocuspocusRoom(
    branchId: string,
    generation: number,
  ): Promise<{
    branchId: string;
    documentId: DocumentId;
    /** The Work whose draft the room is; its lifecycle caps the room's access. */
    workId: WorkId;
    generation: number;
    schemaVersion: CollabSchemaVersion;
    status: "active";
  } | null>;
  loadHocuspocusDocument(documentId: DocumentId, document?: Y.Doc): Promise<Uint8Array | undefined>;
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
  validateHocuspocusDocument(documentId: DocumentId, document: Y.Doc): Promise<void>;
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

export class ReverseThreadContextError extends Error {
  constructor(
    readonly code: "invalid_write" | "document_not_found" | "invalid_scope",
    message: string,
  ) {
    super(message);
  }
}

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
      /** Documents the save left out (D29); their writes were not saved. */
      refused: RefusedResponseDocument[];
      awarenessDegraded?: boolean;
    }
  | DraftClosedFinalizeResult;

export type ResponseWriteRollbackFinalizeResult = {
  stagedCreates: ResponseWriteStagedCreates;
};

export type ResponseWriteFinalizer = {
  finalizeResponseCommit(
    responseIdentity: import("@meridian/contracts").ModelResponseIdentity,
    ctx: { threadId: ThreadId; turnId: TurnId },
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
      liveRevisionToken: string;
      draftRevisionToken?: string;
    };

/**
 * A writer command's answer (§4.6): the stored wire body, still pending, blocked, or the id
 * belongs to a different command. The route maps these to HTTP.
 */
export type CommandOutcome =
  | { kind: "result"; result: DraftCommandResult }
  | { kind: "pending" }
  | { kind: "blocked" }
  | { kind: "conflict" };

/** The model-facing list row: which documents have a draft, nothing more. */
export type ModelDraftRow = {
  documentId: DocumentId;
  documentName: string | null;
  contextLocation: import("@meridian/contracts/drafts").ThreadDraftListItem["contextLocation"];
  createdDocument?: boolean;
};

export type DraftPreviewResult =
  | (DerivedReview & { threadTitles: ReadonlyMap<string, string> })
  | { status: "gone"; itemKey: string }
  | { status: "corrupt"; draftId: DraftId; itemKey: string; branchGeneration: number };

export type DraftReviewApi = {
  list(input: { projectId?: ProjectId; workId: WorkId }): Promise<ModelDraftRow[]>;
  /** The review list route's one read: the active draft's listed items with live text tokens. */
  listItems(input: { workId: WorkId }): Promise<{
    draftId: DraftId | null;
    items: DraftReviewItem[];
    threadTitles: ReadonlyMap<string, string>;
  }>;
  /** The Work's active draft's listed items, live text tokens unread: what Apply authorizes. */
  items(input: { workId: WorkId }): Promise<{ draftId: DraftId | null; items: DraftReviewItem[] }>;
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
    envelope: DraftCommandEnvelope;
    tokens?: Omit<ApplyItemRef, "itemKey">;
    signal?: AbortSignal;
  }): Promise<CommandOutcome>;
  applyAll(input: {
    workId: WorkId;
    draftId: DraftId;
    items: readonly ApplyItemRef[];
    userId: UserId;
    envelope: DraftCommandEnvelope;
    signal?: AbortSignal;
  }): Promise<CommandOutcome>;
  applyChanges(input: {
    workId: WorkId;
    itemKey: string;
    userId: UserId;
    envelope: DraftCommandEnvelope;
    selection: Extract<ReviewSelectionCommand, { kind: "apply" }>;
    signal?: AbortSignal;
  }): Promise<CommandOutcome>;
  discardItem(input: {
    workId: WorkId;
    item: DraftReviewItem;
    userId: UserId;
    envelope: DraftCommandEnvelope;
  }): Promise<CommandOutcome>;
  discardChanges(input: {
    workId: WorkId;
    itemKey: string;
    userId: UserId;
    envelope: DraftCommandEnvelope;
    selection: Extract<ReviewSelectionCommand, { kind: "discard" }>;
  }): Promise<CommandOutcome>;
  discardAll(input: {
    workId: WorkId;
    draftId: DraftId;
    userId: UserId;
    envelope: DraftCommandEnvelope;
  }): Promise<CommandOutcome>;
};

export type CollabDrafts = {
  draftReview: DraftReviewApi;
};

/** The one drafts resolver (Work → active draft, made only at the write boundary). */
export type CollabDraftResolver = {
  drafts: Drafts;
  /** A drain for the debounced registration of writers' review-room edits (§10.7). */
  draftLinks: Pick<DraftBranchAheadRegistration, "flush">;
  /** Every branch of a draft leased before its transaction: what closing the draft needs. */
  draftLeases: DraftBranchLeases;
  /** Work purge's disposal of the purged Work's drafts through the locked Discard kernel (§2.6). */
  workDraftDisposal: WorkDraftDisposal;
};

export type TurnLiveLineageAccess = {
  listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<LiveLineageDocument[]>;
  listEditedDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocument[]>;
  getTurnReceiptChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
};

export type BranchPushAccess = {
  recoverPendingLiveSettlements(input?: { signal?: AbortSignal }): Promise<number>;
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};

/**
 * The version an effective read reads, and so the view its links spell in:
 * the version the caller's writes change. `live` never touches a draft (D40);
 * a draft read names its Work.
 */
export type EffectiveReadVersion =
  | { destination: "live"; workId?: never }
  | { destination: "draft"; workId: WorkId };

export type BranchPeerShadowAccess = {
  readEffectiveRevision(
    input: {
      documentId: DocumentId;
      /** The reading thread: its peer and its reply's staged writes count. */
      threadId?: ThreadId | null;
    } & EffectiveReadVersion,
  ): Promise<string | null>;
  flushBranchLivePull(documentId: DocumentId): Promise<void>;
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
   * The draft's branch on a document it just created or joined, seeded from its live
   * document (empty: a draft create never seeds live Yjs), in the caller's transaction;
   * idempotent against a racing peer ensure (contract §6.2 step 5).
   */
  ensureCreatedDraftBranch(input: { documentId: DocumentId; draftId: DraftId }): Promise<void>;
  /**
   * Reverse a draft create's branch (contract §12.5, O-11), in the caller's transaction:
   * `stands` when the draft's branch on the document (or a thread peer of it) holds a
   * contribution; otherwise the branches go and, once the transaction commits, their
   * pooled cores, caches and rooms are retired.
   */
  retractCreatedDraftBranch(input: {
    documentId: DocumentId;
    draftId: DraftId;
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
  /** Drops debounced live-to-draft pulls that haven't started; running pulls finish. */
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
  BranchPeerShadowAccess &
  CollabDrafts &
  CollabDraftResolver &
  DocumentCreationAggregate;

export type { DocumentCreationAggregate } from "./domain/document-creation.js";
export type {
  DocumentAuthorityHead,
  DocumentAuthorityHeads,
} from "./domain/ports/document-authority-heads.js";
