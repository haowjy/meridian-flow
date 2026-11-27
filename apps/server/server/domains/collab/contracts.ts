import type { CommandId, DraftId, LinkView } from "@meridian/contracts";
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
import type { DocumentRooms } from "@meridian/document-model/rooms";
import type { SpelledLinkFact } from "@meridian/markup/links";
import type { CollabSchemaVersion } from "@meridian/prosemirror-schema";
import type {
  CommandEnvelope,
  CommandLookup,
  CommandLookupKey,
} from "../../shared/commands/command-record.js";
import type { DrizzleDb } from "../../shared/drizzle-transaction.js";
import type { Result } from "../../shared/result.js";
import type { DocumentPurgeDisposal } from "../context/ports/document-trash.js";
import type { WorkDraftDisposal } from "../projects/index.js";
import type { AgentEditRouter } from "./domain/agent-edit-router.js";
import type { DocumentCreationAggregate } from "./domain/document-creation.js";
import type { ResolvedReviewItem } from "./domain/draft-review-identity.js";
import type { DraftReviewItem } from "./domain/draft-review-items.js";
import type { Drafts } from "./domain/drafts.js";
import type { BoundWrite, ImportLinkBinder, LinkBinder } from "./domain/link-binding.js";
import type { ModelEdits } from "./domain/model-edit.js";
import type { ModelEvidence } from "./domain/model-evidence.js";
import type { DocumentDraftOrigin } from "./domain/ports/work-draft-pending-store.js";
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
  | { code: "stale_document"; documentId: string }
  | { code: "not_found"; documentId: string }
  | { code: "corrupt_state"; documentId: string; message: string };

export type DocumentWriteOrigin =
  | { type: "agent"; actorTurnId: TurnId }
  | { type: "user"; actorUserId: UserId };

export type DocumentWriteResult = {
  documentId: DocumentId;
  markdown: string;
  originType: DocumentWriteOrigin["type"];
  actorTurnId: TurnId | null;
  actorUserId: UserId | null;
};

export type DocumentWriteHook = (event: {
  documentId: DocumentId;
  threadId?: ThreadId;
  at: Date;
}) => Promise<void>;

/** The server's document rooms: the door, and `close` to save and free every room at shutdown. */
export type ServerDocumentRooms = DocumentRooms<DrizzleDb> & { close(): Promise<void> };

export type CollabTransport = {
  rooms: ServerDocumentRooms;
  /** The newest collab schema that wrote the document; null when there is no such document. */
  documentSchemaVersion(documentId: DocumentId): Promise<CollabSchemaVersion | null>;
  /** Documents whose rooms end for good (a purge), after the purge commits. */
  onRoomsEnded(listener: (documentIds: readonly DocumentId[]) => void): () => void;
  /**
   * The drafts that alone hold the document (its create is pending there): its Live room serves
   * their view of it. Unauthorized, like `roomRemoval`.
   */
  draftsHolding(documentId: DocumentId): Promise<DraftId[]>;
  /**
   * The removed document a room serves, with its record, or null while it lives. Unauthorized:
   * the gateway reads it only where it is already refusing, and answers `4208` only to a reader
   * of the document.
   */
  roomRemoval(
    documentId: DocumentId,
  ): Promise<{ documentId: DocumentId; removal: DocumentRemovalRecord } | null>;
};

export type AgentEditAccess = {
  agentEdit(): AgentEditRouter;
  modelEdits(): ModelEdits;
  modelEvidence(): ModelEvidence;
  treeHistory(): AgentTreeHistory;
};

export type TreeReceiptNode = {
  nodeId: string;
  beforeAt: string | null;
  afterAt: string | null;
  copiedFrom?: string;
};

export type TreeReceiptInput = {
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
  draftId?: DraftId;
  shownAt: string;
  reverses?: { kind: "undo" | "redo"; receipt: string };
};

export type TreeReceipt = {
  id: string;
  subject: string;
  records: TreeReceiptInput["records"];
  op: TreeReceiptInput["op"];
  kind: "write" | "undo" | "redo";
  reverses: string | null;
  draftId: string | null;
  turnId: string | null;
  shownAt: string | null;
  /** The command that made it: a create with content is one command, so one Undo step. */
  commandId: string | null;
  wId: number;
  handle: number;
  nodes: string[];
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
  all: TreeReceipt[];
  /** The ordinals of the text edits Undo would take, newest first. */
  text: {
    undo: number[];
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
  draftedInReply(turnId: TurnId): Promise<boolean>;
  /**
   * What a card Undo of a reply takes: the reply's receipts that were not reversed, newest
   * first, each with the nodes it changed, the same receipts by the same `reverses` links as
   * the model's `undo` chooses from; and how many of the reply's receipts a card Undo took back.
   */
  turnSteps(
    threadId: ThreadId,
    turnId: TurnId,
  ): Promise<{ open: TreeReceipt[]; undoneByCard: number }>;
  /**
   * The node this chat's receipts took away from `at`, so an undo there finds it: the latest
   * deleted there or its create undone (the path the model wrote); else what last stood at `at`
   * and was moved or deleted from it, itself or with a folder above it, by this chat's receipts
   * in order (a node's address before the call). A folder's row counts only when `holds` says
   * that folder holds a node at the rest of `at` now: a receipt can't say what a folder held.
   */
  nodeLeftAt(
    threadId: ThreadId,
    at: string,
    holds: (folder: string, rest: string) => boolean,
  ): Promise<{ node: string; folder: boolean } | null>;
  historyOf(threadId: ThreadId, nodeId: string, isDocument: boolean): Promise<NodeHistory>;
};

export type ReverseThreadContextInput = {
  threadId: ThreadId;
  userId: UserId;
  turnId: TurnId;
  /** Minted by the browser for each click; a resend under it answers the stored outcome. */
  commandId: CommandId;
  /**
   * The click's second part (the Work receipts a turn made): run on the documents' outcome in
   * the same command, so the click holds both parts or neither. The Works its receipts name
   * are locked with the documents', before any document lock.
   */
  alongside?: {
    workIds: readonly WorkId[];
    /** Takes the namespace keys the Work step needs, after the tree lists and before any document key. */
    lockNamespaces(): Promise<void>;
    run(outcome: ReversalOutcome): Promise<ReversalOutcome>;
  };
};

export type TurnReversalAccess = {
  reverseTurn(input: {
    threadId: ThreadId;
    turnId: TurnId;
    actor: { type: "user"; userId: string } | { type: "agent" };
    documentIds?: DocumentId[];
  }): Promise<ReversalOutcome>;
  reverseThreadContext(input: ReverseThreadContextInput): Promise<ReversalOutcome>;
};

export type VersionedDocumentRead<T> = { content: T; revision: string | null };

export type HashlineBlock = {
  hash: string;
  body: string;
  destinationFree: string;
  text: string;
  verbatim: boolean;
  links: readonly SpelledLinkFact[];
};

export type HashlineRead = {
  blocks: HashlineBlock[];
  revision: string | null;
  holder: { uri: string | null; view: LinkView };
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
  /** The markdown of the document's text, even one in the trash; empty when it holds none. */
  readAsMarkdown(documentId: string): Promise<Result<string, SyncError>>;
  /** Writes only a document with no state yet; otherwise a no-op. */
  seedFromMarkdown(
    documentId: string,
    content: BoundWrite,
    origin: DocumentSeedOrigin,
  ): Promise<Result<void, SyncError>>;
  /**
   * Ends the documents' loaded rooms without saving them, inside the transaction that holds their
   * locks and is about to delete their rows (a content release). Also deletes the stored text of
   * documents that never got a row (an import that ended early).
   */
  endDocumentRooms(documentIds: readonly DocumentId[]): Promise<void>;
  encodeSeed(content: BoundWrite, origin: DocumentSeedOrigin): Uint8Array;
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
   * Brings the change from `base` to `target` into a code document's text, merged under the
   * document's lock against what it holds then; where `base` and the live text both changed the
   * same text, the live text stays. Inside the caller's transaction like any write.
   */
  mergeCodeText(input: {
    documentId: DocumentId;
    base: string;
    target: string;
    origin: DocumentWriteOrigin;
  }): Promise<Result<{ text: string; clashes: number; changed: boolean }, SyncError>>;
};

export type DocumentProjectionRefresher = {
  documentDerivations: import("./domain/ports/document-derivations.js").DocumentDerivationService;
  refreshDocumentProjection(input: { documentId: DocumentId; threadId?: ThreadId }): Promise<void>;
};

export type ModelDraftRow = {
  documentId: DocumentId;
  documentName: string | null;
  contextLocation: import("@meridian/contracts/drafts").DraftItem["contextLocation"];
  createdDocument?: boolean;
};

export type DraftReviewApi = {
  purgeDiscards(): Promise<number>;
  list(input: { draft: DraftId }): Promise<ModelDraftRow[]>;
  listItems(input: { draft: DraftId }): Promise<{
    items: DraftReviewItem[];
    folders: { id: string }[];
    threadTitles: ReadonlyMap<string, string>;
    saw: import("@meridian/contracts/drafts").TreeSaw;
  }>;
  pendingDocumentCount(projectId: ProjectId): Promise<number>;
  /** Every draft in the project with changes to the document, oldest first. */
  draftsChangingDocument(input: {
    projectId: ProjectId;
    documentId: DocumentId;
  }): Promise<DocumentDraftOrigin[]>;
  /** The draft's listed items, live text tokens unread: what Apply authorizes. */
  items(input: { draft: DraftId }): Promise<{ draftId: DraftId; items: DraftReviewItem[] }>;
  resolveItem(input: { itemKey: string }): Promise<ResolvedReviewItem | null>;
  resolveItemInDraft(input: {
    draftId: DraftId;
    documentId: DocumentId;
  }): Promise<ResolvedReviewItem | null>;
  lookupCommand(key: CommandLookupKey): Promise<CommandLookup>;
  /** `lookupCommand` for a resend: waits a while on a first request still running under the id. */
  awaitCommand(envelope: CommandEnvelope): Promise<CommandLookup | { kind: "running" }>;
};

export type CollabDrafts = {
  draftReview: DraftReviewApi;
  workDrafts: import("./adapters/drizzle-work-drafts.js").WorkDrafts;
  presses: import("./adapters/drizzle-press.js").PressStore;
};

export type CollabDraftResolver = {
  drafts: Drafts;
  workDraftDisposal: WorkDraftDisposal;
  documentPurgeDisposal: DocumentPurgeDisposal;
};

export type TurnLiveLineageAccess = {
  listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<LiveLineageDocument[]>;
  listEditedDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocument[]>;
  listFoldersForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnTreeFolder[]>;
  getDocumentAndTreeChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
};

/**
 * The version an effective read reads, and so the view its links spell in:
 * the version the caller's writes change. `live` never touches a draft;
 * a draft read names its draft.
 */
export type EffectiveReadVersion =
  | { destination: "live"; workId?: never }
  | { destination: "draft"; draft: DraftId };

export type EffectiveBlocksRead = VersionedDocumentRead<
  readonly import("@meridian/markup").PMNode[]
> & {
  version: "live" | "draft";
  holderUri: string | null;
  roomVersion: Uint8Array;
  /**
   * The document each `ahead:` ref in this cut now settles to. A ref minted before its target
   * existed still reads as its target, so a copy has to remap it like a `doc:` ref.
   */
  aheadSettlements: ReadonlyMap<string, string>;
};

export type EffectiveDocumentReader = {
  readEffectiveRevision(
    input: {
      documentId: DocumentId;
      threadId?: ThreadId | null;
    } & EffectiveReadVersion,
  ): Promise<string | null>;
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
  readStoredWordCounts(documentIds: DocumentId[]): Promise<Map<DocumentId, number>>;
  readDraftMarkdown(input: {
    documentId: DocumentId;
    draft: DraftId;
  }): Promise<Result<VersionedDocumentRead<string>, SyncError>>;
  readEffectiveMarkdown(
    input: {
      documentId: DocumentId;
      threadId?: ThreadId | null;
    } & EffectiveReadVersion,
  ): Promise<Result<VersionedDocumentRead<string>, SyncError>>;
  /**
   * One document's frozen cut for a copy: the blocks a whole-document write would see,
   * the revision a `read` of that version reports, the holder those links spell from, and
   * the room version of the cut (what a client's own version is compared against). A draft
   * view reads the draft's fork room (Live where the draft wrote nothing), and its links spell
   * in the draft's tree view.
   */
  readEffectiveBlocks(
    input: { documentId: DocumentId } & EffectiveReadVersion,
  ): Promise<Result<EffectiveBlocksRead, SyncError>>;
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
   * A Work's copy's documents' first text, written into Live: a document a draft's create made is
   * plain Live text, and the pending create is its whole pending state.
   */
  writeWorkCreatedContent(
    created: readonly { documentId: DocumentId; content: BoundWrite }[],
    origin: DocumentWriteOrigin,
  ): Promise<void>;
};

export type CollabLifecycle = {
  /**
   * Drops projection runs that haven't started; running ones finish.
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
  EffectiveDocumentReader &
  CollabDrafts &
  CollabDraftResolver &
  DocumentCreationAggregate & { importBinder: ImportLinkBinder };

export type { DocumentCreationAggregate } from "./domain/document-creation.js";
