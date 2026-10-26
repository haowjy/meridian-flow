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
import type { ProjectId } from "@meridian/contracts";
import type {
  ContextParentOrderPolicy,
  DocumentFileType,
  Filetype,
} from "@meridian/contracts/protocol";
import type { DocumentCreationMetadata } from "../document-metadata.js";
import type { LiveClaim, LiveCreateCandidate } from "../tree/hidden-node-types.js";
import type { PathResolution, TreeView } from "../tree/tree-view.js";

/** Opposite-kind occupancy is a normal namespace conflict, not a storage failure. */
export class ContextEntryConflictError extends Error {
  constructor(readonly occupantKind?: "file" | "folder") {
    super("Context entry already exists");
    this.name = "ContextEntryConflictError";
  }
}

export interface ContextFolder {
  id: string;
  parentId: string | null;
  name: string;
  rank?: string | null;
  orderPolicy?: ContextParentOrderPolicy;
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
  rank?: string | null;
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
  /**
   * A device's create id this reveal forwards to the revealed document: written with the
   * reveal, before the catalog refresh that reads it, so a join and its forward commit together.
   */
  joinFrom?: { fromId: string; projectId: ProjectId };
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

export interface ContextDocumentStore {
  /** Run several per-source CRUD operations atomically when the adapter supports it. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  /** The backing context_sources.id for this scoped tree. */
  contextSourceId(): Promise<string>;
  /** Return the backing source when already materialized, without provisioning it. */
  existingContextSourceId(): Promise<string | null>;
  /**
   * What `view` shows at a source-relative path, by the tree reader's one meaning of "same
   * path": two nodes there answer `ambiguous`, never a pick. A path of the other kind is
   * `not_found`. The source root (`""`) is the folder `null`.
   */
  resolveDocumentAt(view: TreeView, path: string): Promise<PathResolution<ContextDocument>>;
  resolveFolderAt(view: TreeView, path: string): Promise<PathResolution<ContextFolder | null>>;
  /** The live document under this canonical name: for mutations that already hold the namespace. */
  findDocument(
    folderId: string | null,
    name: string,
    extension: string,
  ): Promise<ContextDocument | null>;
  /** A document visible in the view, by id, with its path there. */
  findDocumentById(view: TreeView, documentId: string): Promise<LocatedContextDocument | null>;
  /** The document a device's create `fromId` joined, within `projectId`; null when none. */
  findForward(fromId: string, projectId: ProjectId): Promise<string | null>;
  /** Filenames hidden documents and folders hold in `folderId`: names no live create may take. */
  listHiddenNames(folderId: string | null): Promise<string[]>;
  /** A document of this source by id, deleted ones too, with its path there. */
  findDocumentLastLocation(
    documentId: string,
  ): Promise<{ path: string; name: string; deleted: boolean } | null>;
  readProjections(ids: string[]): Promise<Map<string, string>>;
  parentOrderPolicy(view: TreeView, parentId: string | null): Promise<"default" | "manual">;
  listFolders(view: TreeView, parentId: string | null): Promise<ContextFolder[]>;
  listDocuments(view: TreeView, folderId: string | null): Promise<ContextDocument[]>;
  /**
   * Live folders for `dir`, revealing a hidden folder at a path instead of making a twin;
   * throws {@link ContextEntryConflictError} when a document holds a segment's path.
   */
  ensureFolderPath(dir: readonly string[]): Promise<string | null>;
  /** What a live create at this path would reveal, holding nothing (§6.3 step 1). */
  findLiveCreateCandidate(
    dir: readonly string[],
    name: string,
    extension: string,
  ): Promise<LiveCreateCandidate>;
  /**
   * Claim only the SQL/tree identity, live, under `claim` (default `any`: reveal the
   * hidden document at the path or insert). Null when the path is taken; a claim the
   * locks don't confirm throws {@link LiveCreateCandidateChangedError}; a live folder at the
   * document's canonical name throws {@link ContextEntryConflictError} with the folder kind.
   * The document-creation aggregate owns Yjs initialization around this operation.
   */
  createDocumentRecordIfAbsent(
    input: CreateDocumentInput,
    claim?: LiveClaim,
  ): Promise<LiveDocumentCreation | null>;
  createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument>;
}
