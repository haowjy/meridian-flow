/** Public contracts for the collab domain. */
import type { Hocuspocus, Document as HocuspocusDocument } from "@hocuspocus/server";
import type { BranchId, DocumentCommandId, DraftOwner, LinkView } from "@meridian/contracts";
import type { DiscardCommandResult } from "@meridian/contracts/branches";
import type {
  DocumentRemovalRecord,
  ReversalOutcome,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { SpelledLinkFact } from "@meridian/markup/links";
import type { CollabSchemaVersion } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import type { Result } from "../../shared/result.js";
import type { DocumentPurgeDraftDisposal } from "../context/ports/document-trash.js";
import type { WorkBranchDisposal } from "../projects/index.js";
import type { AgentEditRouter } from "./domain/agent-edit-router.js";
import type { DiscardItem, DiscardSelection } from "./domain/branch-discard.js";
import type { ResolvedReviewItem } from "./domain/branch-review-identity.js";
import type { DraftReviewItem } from "./domain/branch-review-items.js";
import type { Branches } from "./domain/branches.js";
import type {
  CommandLookup,
  CommandLookupKey,
  DocumentCommandEnvelope,
} from "./domain/document-commands.js";
import type { DocumentCreationAggregate } from "./domain/document-creation.js";
import type { DraftAheadRegistration } from "./domain/draft-ahead-registration.js";
import type { BoundWrite, ImportLinkBinder, LinkBinder } from "./domain/link-binding.js";
import type { ModelEdits } from "./domain/model-edit.js";
import type { ModelEvidence } from "./domain/model-evidence.js";
import type { BranchOwnerView } from "./domain/ports/branch-store.js";
import type { DocumentBranchOrigin } from "./domain/ports/work-branch-pending-store.js";
import type {
  LiveLineageDocument,
  TurnEditedDocument,
  TurnTreeFolder,
} from "./domain/turn-live-lineage.js";

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
    /** The owner whose draft the room is; its lifecycle caps the room's access. */
    owner: DraftOwner;
    schemaVersion: CollabSchemaVersion;
    status: "active";
  } | null>;
  loadHocuspocusDocument(documentId: DocumentId, document?: Y.Doc): Promise<Uint8Array | undefined>;
  loadHocuspocusDraftState(draftId: string): Promise<{ state: Uint8Array } | undefined>;
  admitLiveWriterUpdate(input: {
    documentId: DocumentId;
    document: Y.Doc;
    update: Uint8Array;
    origin: Extract<UpdateOrigin, { type: "user" | "system" }>;
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
   * true while the draft is active.
   */
  reconcileHocuspocusDraftRoom(input: { draftId: string; room: Y.Doc }): Promise<boolean>;
  /**
   * Called from a draft room's load hook: once Hocuspocus registers the room, brings it up to
   * what committed while it loaded, or closes it when the draft ended.
   */
  enrollHocuspocusDraftRoom(input: { draftId: string; document: HocuspocusDocument }): void;
  getPersistenceQueueMetrics(): CollabPersistenceMetrics;
};

export type AgentEditAccess = {
  /** The model's reads; each names its destination. */
  agentEdit(): AgentEditRouter;
  /** A model's document-changing calls as commands. */
  modelEdits(): ModelEdits;
  /** What the model was shown of documents: written at an edit and at a stored result. */
  modelEvidence(): ModelEvidence;
  /** The model's moves and deletes in the documents' edit history. */
  treeHistory(): AgentTreeHistory;
};

/** A node a tree call changed, with its address before and after (null: created, or deleted). */
export type TreeReceiptNode = {
  nodeId: string;
  beforeAt: string | null;
  afterAt: string | null;
};

/** One record a model's tree call admitted, as its receipt keeps it. */
export type TreeReceiptInput = {
  /** The node the handle hangs on: the one acted on, or the folder several were moved into. */
  subject: string;
  /** Every node the call changed, the subject included: each takes a write ordinal of its own. */
  nodes: readonly TreeReceiptNode[];
  /** The records the call admitted, in order. */
  records: Array<{ record: string; node: string }>;
  op: "create" | "move" | "delete" | "restore";
  threadId: ThreadId;
  turnId?: TurnId;
  responseIdentity?: import("@meridian/contracts").ResponseAuthorship;
  toolCallId?: string;
  /** The Work's branch the record was drafted in; absent when it is live. */
  draftBranchId?: import("@meridian/contracts").BranchId;
  /** The path the model gave. */
  shownAt: string;
  /** The change moved a document between two lists (a project's and the account's). */
  acrossLists?: true;
  /** An undo or redo names the receipt it reverses. */
  reverses?: { kind: "undo" | "redo"; receipt: string };
};

/**
 * The server's move back for a receipt of a move between a project's files and the account's:
 * the context port's own `moveAcrossLists`, which the caller builds from the thread's context.
 * `superseded`: the node was moved or changed since, or is gone; else the move was refused.
 */
export type MoveBackAcrossLists = (
  receipt: TreeReceipt,
) => Promise<
  | { ok: true; records: { left: string; entered: string } }
  | { ok: false; cause: "superseded" | "refused" }
>;

export type TreeReceipt = {
  id: string;
  subject: string;
  records: TreeReceiptInput["records"];
  op: TreeReceiptInput["op"];
  kind: "write" | "undo" | "redo";
  reverses: string | null;
  draftBranchId: string | null;
  turnId: string | null;
  /** The path the model gave for it. */
  shownAt: string | null;
  /** The command that made it: a create with content is one command, so one Undo step. */
  commandId: string | null;
  /** The write ordinal of the node this receipt was found by. */
  wId: number;
  /** The write ordinal on the subject's counter: the handle the model was given. */
  handle: number;
  /** Every node the call changed. */
  nodes: string[];
  /** For a move between two lists: the subject's address before and after. */
  across?: { from: string; to: string };
};

/**
 * One chat's history of a node, the one order Undo, Redo and `revert` choose from: the tree
 * receipts that changed it, and the write ordinals of its text edits. Both take their ordinal
 * from the node's counter, so a larger one is later.
 */
export type NodeHistory = {
  /** Receipts that take a step back (a write or a redo) and were not themselves reversed, newest first. */
  undo: TreeReceipt[];
  /** Receipts that took a step back (an undo) and were not redone, newest first. */
  redo: TreeReceipt[];
  /** Every receipt of the node by its handle on that node. */
  all: TreeReceipt[];
  /** The ordinals of the text edits Undo would take, newest first, and of the one Redo would. */
  text: {
    undo: number[];
    redo: number | null;
    /** The command of each text edit by ordinal, where it has one: what makes a step of a tree receipt's command. */
    commands: Record<number, string>;
  };
};

export type AgentTreeHistory = {
  /**
   * Keeps a model's tree record as a receipt, in the tool call's own transaction, and returns its
   * handle on the subject's counter for this chat.
   */
  recordAgentTreeChange(input: TreeReceiptInput): Promise<{ handle: string; id: string }>;
  /** Whether the turn (one reply) already made a drafted tree change. */
  draftedInReply(turnId: TurnId): Promise<boolean>;
  /**
   * What a card Undo or Redo of a reply takes: the reply's receipts that were not reversed (Undo,
   * newest first), or the ones a reversal took back and nothing redid (Redo, oldest first), each
   * with the nodes it changed. The same receipts, reversed by the same `reverses` links, as
   * the model's `undo` chooses from.
   */
  turnSteps(threadId: ThreadId, turnId: TurnId, direction: "undo" | "redo"): Promise<TreeReceipt[]>;
  /** The chat's receipts for the path its model wrote, newest first: how an undo finds a deleted node. */
  receiptsAt(threadId: ThreadId, shownAt: string): Promise<TreeReceipt[]>;
  /** This chat's history of a node: its tree receipts and the ordinals of its text edits. */
  historyOf(threadId: ThreadId, nodeId: string, isDocument: boolean): Promise<NodeHistory>;
  /** The Works (`Work "‹name›"`) whose active drafts of a document still change it. */
  survivingDraftWorks(documentId: DocumentId): Promise<string[]>;
};

export type ReverseThreadContextInput = {
  threadId: ThreadId;
  userId: UserId;
  direction: "undo" | "redo";
  turnId: TurnId;
  /** Minted by the browser for each click; a resend under it answers the stored outcome. */
  commandId: DocumentCommandId;
  /**
   * The click's second part (the Work receipts a turn made), on the documents' outcome: its
   * own command, under an id derived from `commandId`, once the documents' committed. Its
   * stored outcome is the click's answer.
   */
  alongside?: (outcome: ReversalOutcome) => Promise<ReversalOutcome>;
  /** How a move between lists is taken back; without it, such a step is refused. */
  moveBackAcrossLists?: MoveBackAcrossLists;
};

export type TurnReversalAccess = {
  reverseTurn(input: {
    threadId: ThreadId;
    turnId: TurnId;
    direction: "undo" | "redo";
    actor: { type: "user"; userId: string } | { type: "agent" };
    documentIds?: DocumentId[];
    moveBackAcrossLists?: MoveBackAcrossLists;
  }): Promise<ReversalOutcome>;
  reverseThreadContext(input: ReverseThreadContextInput): Promise<ReversalOutcome>;
};

export type VersionedDocumentRead<T> = { content: T; revision: string | null };

/** One block of a hashline read: what `read` shows, and what grep matches and spells. */
export type HashlineBlock = {
  hash: string;
  /** The block as `read` shows it, with no addressing prefix. */
  body: string;
  /** The block's markdown with link destinations spelled empty. */
  destinationFree: string;
  /** What grep matches in this block: the writer's text, or a code file's text as stored. */
  text: string;
  /** A code file's block: `text` is not a decoding of `destinationFree`. */
  verbatim: boolean;
  /** The ref-bearing links the block spells. */
  links: readonly SpelledLinkFact[];
};

export type HashlineRead = {
  blocks: HashlineBlock[];
  revision: string | null;
  /** The holder `links` were spelled from, as the read's own binding named it. */
  holder: { uri: string | null; view: LinkView };
  /** A range of a block's `destinationFree` markdown, placed in its `body`; null when it can't be. */
  locate(
    block: Pick<HashlineBlock, "body" | "destinationFree">,
    range: { start: number; end: number },
  ): { start: number; end: number } | null;
};

/**
 * Whole-document reads and writes. Writes take `BoundWrite`: bind it with
 * `bindMarkdown` before opening any transaction, then apply it inside one
 * (contract §6.2).
 */
export type MarkdownDocumentStore = LinkBinder & {
  readForExport: import("./domain/markdown-document.js").MarkdownDocumentEngine["readForExport"];
  readVersionedMarkdown(
    documentId: string,
  ): Promise<Result<VersionedDocumentRead<string>, SyncError>>;
  /**
   * Gives a document that has no state its authority, seeded empty: a create's own step, or
   * the repair of an old anomaly on an explicit touch. A no-op when it has authority.
   */
  ensureDocumentAuthority(documentId: DocumentId): Promise<void>;
  readAsMarkdown(documentId: string): Promise<Result<string, SyncError>>;
  /** The markdown of a document's stored Yjs, even one in the trash; empty when it holds none. */
  readFrozenMarkdown(documentId: DocumentId): Promise<string>;
  /** Writes only a document with no state yet; otherwise a no-op. */
  seedFromMarkdown(
    documentId: string,
    content: BoundWrite,
    origin: DocumentSeedOrigin,
  ): Promise<Result<PersistedUpdate | null, SyncError>>;
  /** Deletes the journals of documents that never got a row (an import that ended early). */
  discardUnbornDocuments: import("./domain/ports/initial-document-seeds.js").InitialDocumentSeeds["discardUnbornDocuments"];
  /** A fresh write's first state, built in memory (see the engine's `encodeSeed`). */
  encodeSeed(content: BoundWrite, origin: DocumentSeedOrigin): Uint8Array;
  /** Installs `encodeSeed`'s states as the first of documents the caller's transaction created. */
  installSeeds(
    seeds: readonly { documentId: DocumentId; state: Uint8Array | null }[],
  ): Promise<void>;
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

export type DocumentCheckpoints = {
  checkpoint(documentId: string, reason: string): Promise<Result<string, SyncError>>;
  restore(documentId: string, checkpointId: string): Promise<Result<void, SyncError>>;
  listCheckpoints(documentId: string): Promise<Result<CheckpointInfo[], SyncError>>;
};

/**
 * A writer command's answer: the stored wire body, or the id belongs to a different command.
 * The route maps these to HTTP.
 */
export type CommandOutcome =
  | { kind: "result"; result: DiscardCommandResult }
  | { kind: "conflict" };

/** The model-facing list row: which documents have a draft, nothing more. */
export type ModelDraftRow = {
  documentId: DocumentId;
  documentName: string | null;
  contextLocation: import("@meridian/contracts/branches").ThreadDraftListItem["contextLocation"];
  createdDocument?: boolean;
};

export type DraftReviewApi = {
  /**
   * Apply any selection of nodes, documents and folders, tree and text, as one command; a
   * per-document click is its one-item case.
   */
  apply(input: {
    branchId: BranchId;
    request: import("@meridian/contracts/branches").ApplyItemsClick;
    envelope: DocumentCommandEnvelope;
  }): Promise<import("@meridian/contracts/branches").ApplyClickAnswer>;
  /** One Apply command taken back, text and tree: its document is the command's own record. */
  unapplyClick(input: {
    branchId: BranchId;
    request: import("@meridian/contracts/branches").UnapplyClick;
    envelope: DocumentCommandEnvelope;
  }): Promise<import("@meridian/contracts/branches").UnapplyClickAnswer>;
  /** The documents a command touched, from its own record: what its routes authorize. */
  commandDocuments: {
    ofApply(input: {
      applyCommandId: DocumentCommandId;
      accountId: UserId;
      branchId: BranchId;
    }): Promise<DocumentId[]>;
    ofDiscard(input: {
      discardCommandId: DocumentCommandId;
      accountId: UserId;
      branchId: BranchId;
    }): Promise<DocumentId[]>;
  };
  /** Fresh pending copies of what a Discard settled and closed, on the Work's current branch. */
  undoDiscard(input: {
    /** The branch the Discard ran on; it may have closed with it. */
    branchId: BranchId;
    userId: UserId;
    request: import("@meridian/contracts/branches").UndoDiscardClick;
    envelope: DocumentCommandEnvelope;
  }): Promise<import("@meridian/contracts/branches").UndoDiscardAnswer>;
  list(input: { owner: DraftOwner }): Promise<ModelDraftRow[]>;
  /** The review list route's one read: the active branch's listed items with live text tokens. */
  listItems(input: { owner: DraftOwner }): Promise<{
    branchId: BranchId | null;
    items: DraftReviewItem[];
    /** The folders the branch has a row on, with the revision an Apply of one freezes. */
    folders: { id: string; revision: string }[];
    threadTitles: ReadonlyMap<string, string>;
  }>;
  /** Pending documents summed over the project's active branches. */
  pendingDocumentCount(projectId: ProjectId): Promise<number>;
  /** Every active branch in the project with changes to the document, oldest first. */
  branchesChangingDocument(input: {
    projectId: ProjectId;
    documentId: DocumentId;
  }): Promise<DocumentBranchOrigin[]>;
  /** The owner's active branch's listed items, live text tokens unread: what Apply authorizes. */
  items(input: {
    owner: DraftOwner;
  }): Promise<{ branchId: BranchId | null; items: DraftReviewItem[] }>;
  /** A branch, any status, with its owner and the owner's lifecycle as it reads now. */
  branchOwner(branchId: BranchId): Promise<BranchOwnerView | null>;
  /** The item a key names, when its branch is active. */
  resolveItem(input: { itemKey: string }): Promise<ResolvedReviewItem | null>;
  /** One document of an active branch. */
  resolveItemInBranch(input: {
    branchId: BranchId;
    documentId: DocumentId;
  }): Promise<ResolvedReviewItem | null>;
  /** One document of the owner's active branch. */
  resolveItemByDocument(input: {
    owner: DraftOwner;
    documentId: DocumentId;
  }): Promise<ResolvedReviewItem | null>;
  lookupCommand(key: CommandLookupKey): Promise<CommandLookup>;
  discardItem(input: {
    item: DraftReviewItem;
    /** What ends, and the text draft the writer saw (`DraftDiscardRequest`). */
    ends: DiscardItem["ends"];
    draftSeenAt?: DiscardItem["draftSeenAt"];
    userId: UserId;
    envelope: DocumentCommandEnvelope;
  }): Promise<CommandOutcome>;
  /** The branch's Discard command (`BranchDiscardRequest`): all of it, or a selection of nodes. */
  discardBranch(input: {
    branchId: BranchId;
    selection: DiscardSelection;
    userId: UserId;
    envelope: DocumentCommandEnvelope;
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
  /** Document trash purge's locked retirement of drafts whose content is being released. */
  documentPurgeDraftDisposal: DocumentPurgeDraftDisposal;
};

export type TurnLiveLineageAccess = {
  listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<LiveLineageDocument[]>;
  listEditedDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocument[]>;
  /** The folders the turn changed: its card lists them with the documents. */
  listFoldersForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnTreeFolder[]>;
  getTurnReceiptChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
};

/**
 * The version an effective read reads, and so the view its links spell in:
 * the version the caller's writes change. `live` never touches a draft;
 * a draft read names its Work.
 */
export type EffectiveReadVersion =
  | { destination: "live"; workId?: never }
  | { destination: "draft"; owner: DraftOwner };

/** A draft read of a Work that holds no draft of the document. */
export type WorkDraftMissing = { code: "draft_not_found"; documentId: string };

/** A copy's source cut: the blocks, the revision they had, how they spelled, and its vector. */
export type EffectiveBlocksRead = VersionedDocumentRead<
  readonly import("@meridian/markup").PMNode[]
> & {
  /** Canonical address the cut's links spell from; null for a chat with no holder. */
  holderUri: string | null;
  stateVector: Uint8Array;
  /**
   * The document each `ahead:` ref in this cut now settles to. A ref minted before its target
   * existed still reads as its target, so a copy has to remap it like a `doc:` ref.
   */
  aheadSettlements: ReadonlyMap<string, string>;
};

export type DraftPeerShadowAccess = {
  readEffectiveRevision(
    input: {
      documentId: DocumentId;
      /** The reading thread: its peer and its reply's staged writes count. */
      threadId?: ThreadId | null;
    } & EffectiveReadVersion,
  ): Promise<string | null>;
  flushDraftLivePull(documentId: DocumentId): Promise<void>;
  /**
   * Stored grep text for those of `documentIds` whose text matches what this reader sees: the
   * derived outputs are current, no active draft stands between a draft reader and the live
   * text. Documents left out need a read.
   */
  readStoredGrepTexts(
    input: {
      documentIds: DocumentId[];
      threadId?: ThreadId | null;
    } & EffectiveReadVersion,
  ): Promise<Map<DocumentId, string>>;
  /** Words per document whose derived outputs are current; the others are absent. */
  readStoredWordCounts(documentIds: DocumentId[]): Promise<Map<DocumentId, number>>;
  readEffectiveMarkdown(
    input: {
      documentId: DocumentId;
      threadId?: ThreadId | null;
    } & EffectiveReadVersion,
  ): Promise<Result<VersionedDocumentRead<string>, SyncError>>;
  /**
   * One document's frozen cut for a copy: the blocks a whole-document write would see,
   * the revision a `read` of that version reports, the holder those links spell from, and
   * the Yjs state vector of the cut (what a client's own vector is compared against). A draft
   * read is of the named Work's draft, whatever chat reads it; a Work that holds no draft of
   * the document is `draft_not_found`, never the live document.
   */
  readEffectiveBlocks(
    input: { documentId: DocumentId } & EffectiveReadVersion,
  ): Promise<Result<EffectiveBlocksRead, SyncError | WorkDraftMissing>>;
  /**
   * One hashline per block, and per block the ref-bearing links it spells
   * (`spelledLinks`), computed with the same scope in the same synchronous block.
   */
  readEffectiveHashlines(
    input: {
      documentId: DocumentId;
      threadId?: ThreadId | null;
    } & EffectiveReadVersion,
  ): Promise<Result<HashlineRead, SyncError>>;
  /**
   * Each text document a branch's admitted create just made gets its Yjs authority and its
   * Work text draft (empty: a draft create never seeds live Yjs), in the admitting
   * transaction under the list's key: the tree list store calls it for every create in a
   * Work's version, the writer's and the AI's alike (contract §6.2 step 5).
   */
  draftCreatedDocuments(
    created: readonly { documentId: DocumentId; branchId: BranchId }[],
  ): Promise<void>;
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
  dispose(): Promise<void>;
};

export type CollabDomain = CollabTransport &
  CollabLifecycle &
  AgentEditAccess &
  TurnReversalAccess &
  MarkdownDocumentStore &
  DocumentProjectionRefresher &
  TurnLiveLineageAccess &
  DocumentCheckpoints &
  DocumentAttribution &
  DraftAttributionAccess &
  DraftPeerShadowAccess &
  CollabBranches &
  CollabBranchResolver &
  DocumentCreationAggregate & { importBinder: ImportLinkBinder };

export type { DocumentCreationAggregate } from "./domain/document-creation.js";
