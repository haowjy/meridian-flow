/** Public contracts for the collab domain. */
import type { Hocuspocus, Document as HocuspocusDocument } from "@hocuspocus/server";
import type {
  FrontierLookup,
  ObservationFrontier,
  ResponseCommitWriteReceipt,
} from "@meridian/agent-edit/integration";
import type { BranchId, LinkView } from "@meridian/contracts";
import type { BranchCommandResult } from "@meridian/contracts/branches";
import type {
  DocumentRemovalRecord,
  ReversalOutcome,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
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
  RefusedResponseDocument,
  ThreadPeerAgentEditCore,
} from "./domain/agent-edit-cores.js";

export type { RefusedResponseDocument };

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
import type { DocumentBranchOrigin } from "./domain/ports/work-branch-pending-store.js";
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

export type AdmitLiveWriterUpdateResult = { admitted: true } | { admitted: false };

export type CollabTransport = {
  bindHocuspocus(instance: Hocuspocus): void;
  primeReservedNamespaceIndex(document: Y.Doc): void;
  headSchemaVersion(documentId: DocumentId): Promise<CollabSchemaVersion | null>;
  resolveDraftHocuspocusRoom(draftId: string): Promise<{
    draftId: string;
    documentId: DocumentId;
    /** The Work whose draft the room is; its lifecycle caps the room's access. */
    workId: WorkId;
    schemaVersion: CollabSchemaVersion;
    status: "active";
  } | null>;
  loadHocuspocusDocument(documentId: DocumentId, document?: Y.Doc): Promise<Uint8Array | undefined>;
  loadHocuspocusDraftState(draftId: string): Promise<{ state: Uint8Array } | undefined>;
  admitLiveWriterUpdate(input: {
    documentId: DocumentId;
    document: Y.Doc;
    update: Uint8Array;
    origin: Extract<UpdateOrigin, { type: "user" }>;
    expectedGeneration: bigint;
  }): Promise<AdmitLiveWriterUpdateResult>;
  currentLiveGeneration(documentId: DocumentId): Promise<bigint>;
  /**
   * The removed document a room serves, with its record (a draft room's by its retained draft,
   * at any status, never reopened), or null while it lives. Unauthorized: the gateway reads it
   * only where it is already refusing, and answers `4208` only to a reader of the document.
   */
  roomRemoval(
    room: { documentId: DocumentId } | { draftId: string },
  ): Promise<{ documentId: DocumentId; removal: DocumentRemovalRecord } | null>;
  validateHocuspocusDocument(documentId: DocumentId, document: Y.Doc): Promise<void>;
  admitDraftWriterUpdate(input: {
    draftId: string;
    update: Uint8Array;
    origin: UpdateOrigin;
    document: Y.Doc;
  }): Promise<void>;
  storeHocuspocusDocument(documentId: DocumentId, document: Y.Doc): Promise<void>;
  storeHocuspocusDraft(draftId: string, document: Y.Doc): Promise<void>;
  drainHocuspocusPersistence(): Promise<void>;
  drainHocuspocusDraftPersistence(draftId: string): Promise<void>;
  /** Nonterminal disconnect affordance for the durable shadow-probe T6. */
  closeHocuspocusDraftRoom(draftId: string): void;
  /**
   * A tab's SyncStep1 on a draft room: reconciles `room` against the committed draft, then
   * true while the draft is active (decision D27).
   */
  reconcileHocuspocusDraftRoom(input: { draftId: string; room: Y.Doc }): Promise<boolean>;
  /**
   * Called from a draft room's load hook: once Hocuspocus registers the room, brings it up to
   * what committed while it loaded, or closes it when the draft ended (decision D26).
   */
  enrollHocuspocusDraftRoom(input: { draftId: string; document: HocuspocusDocument }): void;
  getPersistenceQueueMetrics(): CollabPersistenceMetrics;
};

export type AgentEditAccess = {
  /** The one model read/write entry point; each call names its destination. */
  agentEdit(): ThreadPeerAgentEditCore;
  /** The model's moves and deletes in the documents' edit history. */
  treeHistory(): AgentTreeHistory;
};

export type AgentTreeHistory = {
  /**
   * Records a model's create, move or delete as a tree entry, in the tree mutation's own transaction,
   * and returns its handle on the document's counter for this chat.
   */
  recordAgentTreeChange(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    turnId?: TurnId;
    responseIdentity?: import("@meridian/contracts").ModelResponseIdentity;
    toolCallId?: string;
    op: "create" | "move" | "delete";
    change: /** Live: the placement read before the mutation; the entry reads its `after` itself. */
      | {
          destination: "live";
          before: import("@meridian/contracts").LiveTreeState | null;
        }
      /** Drafted: the branch row's facts on either side, as the branch write returned them. */
      | ({ destination: "draft" } & Omit<
          import("@meridian/contracts").BranchTreeTransition,
          "destination"
        > & { branchId: import("@meridian/contracts").BranchId });
    /** Where the model saw the document: the path it moved or deleted it from. */
    shownAt: string;
    /** A move's destination as a canonical URI. */
    landedAt?: string;
  }): Promise<{ handle: string }>;
  /** The document's live state now, as a tree entry records it; null while it is hidden. */
  liveState(documentId: DocumentId): Promise<import("@meridian/contracts").LiveTreeState | null>;
  /** The Works (`Work "‹name›"`) whose active drafts of a document still change it (D79). */
  survivingDraftWorks(documentId: DocumentId): Promise<string[]>;
  /** The document this chat's latest move or delete took away from `path`, if any. */
  movedAwayFrom(threadId: ThreadId, path: string): Promise<DocumentId | null>;
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
  /** The create's own step for an empty create: its authority, empty, in its transaction. */
  initializeEmptyDocument(documentId: DocumentId): Promise<void>;
  /**
   * Explicit repair of a living document whose authority is absent, from its stored
   * projection; a no-op when it has authority. Called only on an explicit touch.
   */
  repairDocumentAuthority(documentId: DocumentId): Promise<void>;
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
  /** Host-only, when the save recorded one: the document's frontier at the save's after-state. */
  frontier?: ObservationFrontier;
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
  /** What the rollback couldn't reverse (a blocked folder path, for example); the rest it did. */
  skipped: import("@meridian/contracts/protocol").TurnInverseSkip[];
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

/**
 * A writer command's answer (§4.6): the stored wire body, still pending, blocked, or the id
 * belongs to a different command. The route maps these to HTTP.
 */
export type CommandOutcome =
  | { kind: "result"; result: BranchCommandResult }
  | { kind: "pending" }
  | { kind: "conflict" };

/** The model-facing list row: which documents have a draft, nothing more. */
export type ModelDraftRow = {
  documentId: DocumentId;
  documentName: string | null;
  contextLocation: import("@meridian/contracts/branches").ThreadDraftListItem["contextLocation"];
  createdDocument?: boolean;
};

export type DraftReviewApi = {
  applyClick(input: {
    workId: WorkId;
    documentId: DocumentId;
    request: import("@meridian/contracts/branches").ApplyClick;
    envelope: BranchCommandEnvelope;
  }): Promise<import("@meridian/contracts/branches").ApplyClickAnswer>;
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
  lookupCommand(key: CommandLookupKey): Promise<CommandLookup>;
  discardItem(input: {
    workId: WorkId;
    item: DraftReviewItem;
    userId: UserId;
    envelope: BranchCommandEnvelope;
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
  ensureCreatedDocumentDraft(input: {
    documentId: DocumentId;
    branchId: BranchId;
  }): Promise<import("./domain/draft-store.js").DraftSnapshot>;
  /**
   * Reverse a branch create's draft (contract §12.5, O-11), in the caller's transaction:
   * `stands` when the branch's draft on the document (or a thread peer of it) holds a
   * contribution; otherwise closes the drafts, which retire after commit.
   */
  retractCreatedDocumentDraft(input: {
    documentId: DocumentId;
    branchId: BranchId;
  }): Promise<"stands" | "retracted">;
};

export type DraftAttributionAccess = {
  readDraftProvenance: ReturnType<
    typeof import("./domain/draft-provenance.js").createDraftProvenanceReader
  >;
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
  AgentEditAccess &
  TurnReversalAccess &
  MarkdownDocumentStore &
  DocumentProjectionRefresher &
  TurnLiveLineageAccess &
  ResponseWriteFinalizer &
  DocumentCheckpoints &
  DocumentAttribution &
  DraftAttributionAccess &
  DraftPeerShadowAccess &
  CollabBranches &
  CollabBranchResolver &
  DocumentCreationAggregate;

export type { DocumentCreationAggregate } from "./domain/document-creation.js";
