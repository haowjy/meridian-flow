/**
 * Primitive folder/document storage for one ContextFS context source.
 *
 * The store deals in single tree nodes — path-resolution and
 * folder-auto-creation for normal writes live in ContextFS. Tree moves/deletes
 * go through ContextTreeMutationStore so location CAS and cross-source re-homing
 * have one atomic owner.
 *
 * `parentId`/`folderId` of `null` denotes the source root.
 */
import type { DocumentId, DraftId } from "@meridian/contracts";
import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";
import type { DocumentCreationMetadata } from "../document-metadata.js";
import type {
  BinaryNode,
  CreateFault,
  DraftCreateResult,
  LiveCreateCandidate,
  TrackedNode,
} from "../tree/hidden-nodes.js";
import type { TreeView } from "../tree/tree-view.js";

/** Opposite-kind occupancy is a normal namespace conflict, not a storage failure. */
export class ContextEntryConflictError extends Error {
  constructor() {
    super("Context entry already exists");
    this.name = "ContextEntryConflictError";
  }
}

export interface ContextFolder {
  id: string;
  parentId: string | null;
  name: string;
}

export interface ContextDocument {
  id: string;
  folderId: string | null;
  name: string;
  extension: string;
  fileType: DocumentFileType | null;
  filetype: Filetype | null;
  storageUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  updatedAt: string;
  provisionalName: boolean;
}

export interface LocatedContextDocument {
  contextSourceId: string;
  document: ContextDocument;
  path: string;
}

export interface CreateDocumentInput {
  /** Optional caller-chosen document id for imports that need stable keys before insert. */
  id?: string;
  folderId: string | null;
  name: string;
  extension: string;
  markdown: string;
  filetype: Filetype;
  provisionalName?: boolean;
  metadata?: DocumentCreationMetadata;
}

/** Input for creating a binary (storage-backed) document in the context tree. */
export interface CreateBinaryDocumentInput {
  id?: string;
  folderId: string | null;
  name: string;
  extension: string;
  fileType: DocumentFileType;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  metadata?: DocumentCreationMetadata;
}

/** Input for creating or overwriting a binary document at the same path. */
export type UpsertBinaryDocumentInput = CreateBinaryDocumentInput;

/** A live create's identity: inserted, or a hidden document revealed at the path (§6.3). */
export interface LiveDocumentCreation {
  document: ContextDocument;
  revealed: boolean;
}

/** The hidden candidate seen before a live create's transaction is no longer the one under its lock. */
export class LiveCreateCandidateChangedError extends Error {
  constructor() {
    super("The hidden document at this path changed before the create could reveal it");
    this.name = "LiveCreateCandidateChangedError";
  }
}

/** What a live create must still be true of under its locks (§6.3 step 4, §6.4). */
export interface LiveCreateExpectation {
  /** The candidate discovered before the transaction, or none. */
  expected?: { documentId: string; sourceId: string } | { none: true };
  /** Reveal exactly this hidden document at the path (link Create, untitled id). */
  revealById?: string;
}

/** A draft's create in this source (§6.2), inside the command transaction that holds the draft. */
export interface DraftCreateInput {
  draftId: DraftId;
  dir: readonly string[];
  name: string;
  extension: string;
  node: TrackedNode | BinaryNode;
  ensureEmptyContent(documentId: DocumentId): Promise<void>;
  ensureDraftBranch(documentId: DocumentId): Promise<void>;
}

export interface ContextDocumentStore {
  /** Run several per-source CRUD operations atomically when the adapter supports it. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  /** The backing context_sources.id for this scoped tree. */
  contextSourceId(): Promise<string>;
  /** Return the backing source when already materialized, without provisioning it. */
  existingContextSourceId(): Promise<string | null>;
  /** Reads see one tree view: live, or one draft's. */
  findFolder(view: TreeView, parentId: string | null, name: string): Promise<ContextFolder | null>;
  findDocument(
    view: TreeView,
    folderId: string | null,
    name: string,
    extension: string,
  ): Promise<ContextDocument | null>;
  /** A document visible in the view, by id, with its path there. */
  findDocumentById(view: TreeView, documentId: string): Promise<LocatedContextDocument | null>;
  /** Where an id stands in the live tree, for caller-chosen ids (untitled, link Create). */
  liveIdentity(
    documentId: string,
  ): Promise<{ kind: "visible" | "hidden"; contextSourceId: string } | { kind: "other" }>;
  readProjections(ids: string[]): Promise<Map<string, string>>;
  listFolders(view: TreeView, parentId: string | null): Promise<ContextFolder[]>;
  listDocuments(view: TreeView, folderId: string | null): Promise<ContextDocument[]>;
  /**
   * Live folders for `dir`, revealing a hidden folder at a path instead of making a twin;
   * throws {@link ContextEntryConflictError} when a document holds a segment's path.
   */
  ensureFolderPath(dir: readonly string[]): Promise<string | null>;
  /** What a live create at this path would reveal, holding nothing (§6.3 step 1). */
  findLiveCreateCandidate(dir: readonly string[], filename: string): Promise<LiveCreateCandidate>;
  createDocument(input: CreateDocumentInput): Promise<ContextDocument>;
  /**
   * Claim only the SQL/tree identity, live: reveal the hidden document at the path or
   * insert a row. Null when the path is taken. The document-creation aggregate owns Yjs
   * initialization around this operation.
   */
  createDocumentRecordIfAbsent(
    input: CreateDocumentInput & LiveCreateExpectation,
  ): Promise<LiveDocumentCreation | null>;
  createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument>;
  upsertBinaryDocument(input: UpsertBinaryDocumentInput): Promise<ContextDocument>;
  /** A draft's create: a hidden row (or another draft's, joined) and the draft's `created` row. */
  createInDraft(input: DraftCreateInput): Promise<Result<DraftCreateResult, CreateFault>>;
  /** Reverse a draft's create (§12.5, O-11); false when the create stands. */
  retractDraftCreate(input: {
    draftId: DraftId;
    workId: string;
    documentId: DocumentId;
  }): Promise<boolean>;
}
