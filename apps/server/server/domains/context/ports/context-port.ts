/**
 * Context port + scheme vocabulary: the stat/read/list/write/search/move/delete
 * contract over context URI schemes plus file-entry, result, and error types.
 */

import type { LinkView } from "@meridian/contracts";
import type {
  ContextUriScheme,
  ProjectScopedContextUriScheme,
  WorkScopedContextUriScheme,
} from "@meridian/contracts/context-uri";
import type {
  ContextError,
  ContextMoveResult,
  ContextOperationReceipt,
  DeleteContextEntryRequest,
  DeleteContextEntryResult,
  DocumentFileType,
  Filetype,
  MoveContextEntryRequest,
  NamespaceNameClaim,
  RetractionCause,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import type { SpelledLinkFact } from "@meridian/markup/links";
import type { Result } from "../../../shared/result.js";
import type { BoundWrite } from "../../collab/index.js";
import type { WorkRef } from "../../file-policy/index.js";
import type { DocumentCreationMetadata } from "../document-metadata.js";
import type { BranchChangeAuthor, RecordedBranchTreeChange } from "./branch-tree.js";

/**
 * Registered context URI schemes.
 *
 * Project-scoped: `manuscript`/`kb`/`user` (bare paths default to `manuscript`).
 * Owned: `scratch` (a Work's, `scratch://@w3/...`, or a lineage's, `scratch://@c12/...`)
 * and `uploads` (a chat's, `uploads://@c15/...`). Only Scratch belongs to a Work.
 */
export type { ContextError, ContextMoveResult } from "@meridian/contracts/protocol";
export type ContextScheme = ContextUriScheme;

/**
 * How one thread reads every source through its port. Reads follow the
 * version that thread's writes change, per document (D14, D20), or the
 * live text, without draft changes, when `version` is `live`.
 */
export interface ThreadContextView {
  scratchOwner?: import("../scratch-owner.js").ScratchOwner;
  /** The chat whose uploads bare `uploads://` names: this thread's top primary (a subagent's parent). */
  uploadsOwner?: UploadsOwner;
  threadId: string;
  /** The reply in progress, whose own staged writes reads still see. */
  responseId?: string | null;
  /** The Work whose branch this thread's drafted writes land in; null outside draft mode (D40). */
  branchWork: WorkRef | null;
  version?: "draft" | "live";
}

/**
 * A chat as the owner of uploads. `chatRef` is null while the chat's row does not exist yet
 * (a New chat's first uploads), so its files have no handle to spell.
 */
export interface UploadsOwner {
  chatId: string;
  chatRef: string | null;
}

/** Schemes provisioned at project scope in the unified context port. */
export type ProjectContextFsScheme = ProjectScopedContextUriScheme;

/** Schemes provisioned per Work in the unified context port. */
export type WorkScopedContextFsScheme = WorkScopedContextUriScheme;

export interface ContextReadResult {
  /** Stable identity resolved by the router for this successful operation. */
  uri: string;
  content: string;
  documentId?: string;
}

export interface ContextWriteResult {
  /** Stable identity resolved by the router for this successful operation. */
  uri: string;
  documentId?: string;
  markdown?: string;
  updateSeq?: number;
}

/** A binary write's outcome: where it landed, as the adapter's placement decided (§2.3). */
export interface ContextBinaryWriteResult extends ContextWriteResult {
  documentId: string;
  placement: "live" | "draft";
}

export interface ContextEnsureTrackedDocumentResult {
  uri: string;
  documentId: string;
  created: boolean;
}

export interface ContextCreateTrackedDocumentResult {
  uri: string;
  documentId: string;
}

export type ContextCreateUntitledDocumentResult =
  | {
      status: "created";
      documentId: string;
      scheme: ContextScheme;
      path: string;
      name: string;
      workId?: string;
    }
  /** The create joined a branch's document; `documentId` is that document, at its current address. */
  | {
      status: "joined";
      documentId: string;
      scheme: ContextScheme;
      path: string;
      name: string;
      workId?: string;
    }
  | {
      status: "already-materialized";
      documentId: string;
      scheme: ContextScheme;
      path: string;
      name: string;
      /** Present only when the canonical location is Work-scoped. */
      workId?: string;
    };

/** What the server already holds under a create's client-minted id, and the address that holds it. */
export interface ContextHeldUntitledDocument {
  /** The create's replay answer: the document it joined, or where the id is materialized. */
  answer: Extract<
    ContextCreateUntitledDocumentResult,
    { status: "joined" | "already-materialized" }
  >;
  /** The canonical URI of that document, for the caller to check its reach. */
  uri: string;
}

export interface ContextCreateUntitledDocumentOptions {
  documentId: string;
  origin: WriteProvenance;
  /**
   * The writer's chosen place for this document, the same identity-based address a move
   * carries. The create joins a branch's hidden document waiting there. Without it the
   * create is nameless: `Untitled N` in the home URI's folder.
   */
  destination?: {
    parent: NonNullable<MoveContextEntryRequest["destinationParent"]>;
    name: string;
    position?: MoveContextEntryRequest["position"];
  };
  /** Refuses a destination the caller may not edit; given the resolved destination URI. */
  authorizeDestination?: (uri: string) => Promise<boolean>;
}

/** What the router hands an adapter: the destination resolved to a folder path and a leaf. */
export interface AdapterCreateUntitledOptions {
  documentId: string;
  origin: WriteProvenance;
  /** The typed leaf filename; absent for a nameless create. */
  name?: string;
  /** The folder identity the destination named: a stale one is retried, never made again. */
  expectFolderId?: string;
  /** Where among the folder's children a new document goes; it never moves one that exists. */
  position?: MoveContextEntryRequest["position"];
}

export interface ContextCreateFolderOptions {
  folderId: string;
  origin: WriteProvenance;
  /** Where the writer put the folder; the same identity-based address a move carries. */
  destination: {
    parent: NonNullable<MoveContextEntryRequest["destinationParent"]>;
    name: string;
    position?: MoveContextEntryRequest["position"];
  };
  /** Refuses a destination the caller may not edit; given the resolved destination URI. */
  authorizeDestination?: (uri: string) => Promise<boolean>;
}

export interface ContextCreateFolderResult {
  /** `already-exists` answers a replay of the same id. */
  status: "created" | "already-exists";
  folderId: string;
  scheme: ContextScheme;
  path: string;
  name: string;
  workId?: string;
}

/** What the server already holds under a create's client-minted folder id. */
export type ContextHeldFolder =
  | {
      /** The create's replay answer: the folder id is materialized at this address. */
      answer: ContextCreateFolderResult & { status: "already-exists" };
      /** The canonical URI of that folder, for the caller to check its reach. */
      uri: string;
    }
  /** The id is held where the caller cannot reach or reuse it: a typed final conflict. */
  | { conflict: true };

/** What the router hands an adapter: the destination resolved to a folder path and a leaf. */
export interface AdapterCreateFolderOptions {
  folderId: string;
  origin: WriteProvenance;
  /** The typed folder name; a taken one yields to the first free name. */
  name: string;
  /** The folder identity the destination named: a stale one is retried, never made again. */
  expectFolderId?: string;
  /** Where among the folder's siblings a new folder goes. */
  position?: MoveContextEntryRequest["position"];
}

interface BaseListEntry {
  uri: string;
  title?: string | null;
  documentId?: string;
  folderId?: string;
  sizeBytes?: number;
  updatedAt?: string;
  /** True when the entry's scheme is read-only. */
  readonly?: boolean;
  provisionalName?: boolean;
}

export type EditableFileEntry = BaseListEntry & {
  kind: "file";
  editable: true;
  filetype: Filetype;
  schemaType: YjsTrackedSchemaType;
  /** Words in the projection; set only when {@link ContextListOptions.wordCounts} asks. */
  wordCount?: number;
};

export type BinaryFileEntry = BaseListEntry & {
  kind: "file";
  editable: false;
  fileType: DocumentFileType;
  mimeType?: string;
};

export type DirectoryEntry = BaseListEntry & { kind: "directory" };

export type ContextFileEntry = EditableFileEntry | BinaryFileEntry;
export type ContextListEntry = DirectoryEntry | ContextFileEntry;
export type FileEntry = ContextListEntry;

/** A folder's entries and the folder's canonical URI; `uri` is null for the root listing. */
export interface ContextListing {
  uri: string | null;
  entries: ContextListEntry[];
}

export interface ContextListOptions {
  /** Count each text document's words from its projection (no extra query). */
  wordCounts?: boolean;
}

interface BaseFileRef {
  uri: string;
  documentId?: string;
  sizeBytes?: number;
  updatedAt?: string;
  /** True when the file's scheme is read-only. */
  readonly?: boolean;
}

/** A Yjs/projected text file ref returned by {@link ContextPort.stat}. */
export interface TrackedFileRef extends BaseFileRef {
  kind: "tracked";
  filetype: Filetype;
  schemaType: YjsTrackedSchemaType;
}

/** A storage-backed binary file ref returned by {@link ContextPort.stat}. */
export interface BinaryFileRef extends BaseFileRef {
  kind: "binary";
  fileType: DocumentFileType;
  /** Stable object-store reference for storage-backed files. */
  storageUrl: string;
  /** Persisted MIME type for the stored object, when known. */
  mimeType?: string;
}

/** A single-file lookup result returned by {@link ContextPort.stat}. */
export type FileRef = TrackedFileRef | BinaryFileRef;

/** One matched passage inside a {@link SearchResult}. */
export interface SearchMatch {
  /** Matched line or snippet. */
  excerpt: string;
  /**
   * Hash of the block the excerpt came from, so a caller can navigate back to
   * the passage rather than to the top of the file. Present only for schemes
   * whose documents are serialized as hashlines (drafted sources read
   * through a thread view); its absence elsewhere is the contract, not an error.
   */
  blockHash?: string;
}

/** What a search hit's passages spell, from the read binding that spelled them. */
export interface SearchShowing {
  holderUri: string;
  view: LinkView;
  /** Aligned with {@link SearchResult.matches}. */
  passages: readonly (readonly SpelledLinkFact[])[];
}

/** Every passage one file contributed to a {@link ContextPort.search}. */
export interface SearchResult {
  /** Host-only source identity; tools strip it from model-facing output. */
  documentId: string;
  revision: string | null;
  /** Canonical `scheme://path` URI of the matched file. */
  uri: string;
  /** Matching passages in file order, capped by the adapter. Never empty. */
  matches: SearchMatch[];
  /**
   * How many times the query occurs in this file, including occurrences past
   * the passage cap. This is what stays honest about what was left out.
   */
  matchCount: number;
  /** Relevance score, 0-1. Adapter-dependent. */
  score?: number;
  /**
   * Host-only: each ref-bearing link the returned passages spell, aligned with
   * `matches`, and the holder URI and view the read's binding spelled them
   * from. Tools strip it; the host records a passage's links only when the
   * text the model receives shows that passage whole, and only for hits the
   * reader may see.
   */
  shown?: SearchShowing;
}

export type WriteProvenance =
  | { type: "agent"; agentSlug: string | null; threadId: string; turnId: string }
  | { type: "human"; userId: string; threadId?: string }
  | { type: "import"; userId: string; source: string; filename: string; sourceId?: string }
  | { type: "system" };

export interface ContextWriteOptions {
  /** Extension inherited by an extensionless copy destination. */
  sourceExtension?: string;
  origin?: WriteProvenance;
  /**
   * Stable identity reserved by an authoritative aggregate before content creation (an
   * upload's reservation): a create mints it.
   */
  documentId?: string;
  /** Recorded in `documents.metadata` when this call creates the document; never on an existing one. */
  metadata?: DocumentCreationMetadata;
}

export interface ContextLocationOptions extends ContextWriteOptions {
  destinationParent?: MoveContextEntryRequest["destinationParent"];
  position?: MoveContextEntryRequest["position"];
  /** Reconfirm the resolved destination's edit authority under its namespace locks. */
  authorizeDestination?: (uri: string) => Promise<boolean>;
  operationId?: string;
  expected?: MoveContextEntryRequest["expected"];
  /**
   * Runs inside the move's own transaction once its rows are written, so a caller's record of
   * the move (the model's edit history) commits or rolls back with it.
   */
  inTransaction?: (moved: ContextMoveResult) => Promise<void>;
}

export interface ContextMoveOptions extends ContextWriteOptions {
  overwrite?: boolean;
}

/** What `changeInBranch` does: the document it names must be at the source address. */
export type ContextBranchTreeCommand = {
  documentId: string;
  changedBy: BranchChangeAuthor;
  record(change: RecordedBranchTreeChange): Promise<void>;
} & (
  | {
      op: "move";
      sourceUri: string;
      destinationUri: string;
      position?: MoveContextEntryRequest["position"];
    }
  | { op: "delete"; uri: string }
);

export type ContextBranchTreeResult = { uri: string; moved: boolean };

export interface ContextDeleteOptions extends ContextWriteOptions {
  removal?: { reason: "discarded"; cause: RetractionCause };
  operationId?: string;
  expected: DeleteContextEntryRequest["expected"];
  /** Runs inside the delete's own transaction once the removal is written (see the move's). */
  inTransaction?: (deleted: DeleteContextEntryResult) => Promise<void>;
}

/** Input for writing a binary (storage-backed) document through {@link ContextPort.writeBinary}. */
export interface ContextWriteBinaryOptions extends ContextWriteOptions {
  fileType: DocumentFileType;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * The text-oriented interface over the agent's heterogeneous storage. The
 * router parses URIs and dispatches by scheme to the registered adapter.
 *
 * All methods return {@link Result} — no errors are thrown across this
 * boundary (architecture-constraints #7).
 */
export interface ContextPort {
  lookupOperation(operationId: string): Promise<ContextOperationReceipt | null>;
  /** Resolve metadata for one file by URI. `not_found` if it does not exist or names a directory. */
  stat(uri: string): Promise<Result<FileRef, ContextError>>;

  /** Read a text file by URI. `not_found` if it does not exist. */
  read(uri: string): Promise<Result<ContextReadResult, ContextError>>;

  /** Overwrite the document at a URI with text. `not_found` when none lives there: it never creates. */
  write(
    uri: string,
    content: string,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextWriteResult, ContextError>>;

  /**
   * Bind content for a tracked document about to be created at `uri`.
   * Runs outside any transaction (it may register ahead refs); a caller that
   * creates inside its own transaction binds first (contract §6.2).
   */
  bindTrackedDocument(uri: string, content: string): Promise<Result<BoundWrite, ContextError>>;

  /**
   * Claim and seed a new tracked URI without ever replacing an existing path.
   * Its Markdown is bound here, outside any transaction; a caller inside
   * its own transaction binds first and uses `createBoundDocument`.
   */
  createTrackedDocument(
    uri: string,
    markdown: string,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextCreateTrackedDocumentResult, ContextError>>;

  /** Allocate the first free leaf at `uri`, then create its identity and initial content together. */
  createTrackedDocumentAtFreeName(
    uri: string,
    markdown: string,
    reserved: readonly NamespaceNameClaim[],
    options?: ContextWriteOptions,
  ): Promise<Result<ContextCreateTrackedDocumentResult, ContextError>>;

  /**
   * `createTrackedDocument` with content `bindTrackedDocument` made for
   * this URI (null: empty); safe inside a transaction.
   */
  createBoundDocument(
    uri: string,
    bound: BoundWrite | null,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextCreateTrackedDocumentResult, ContextError>>;

  /**
   * Where this reader sees a document, by id: its URI in the first of this port's sources
   * that shows it (the scan untitled creation uses to find a materialized id), or null.
   */
  locate(
    documentId: string,
  ): Promise<Result<{ documentId: string; uri: string } | null, ContextError>>;

  /**
   * What this port already holds under a create's client-minted id: the document its create
   * joined, else the place the id is materialized, else null. Read-only and unaware of the
   * create's destination, so a replay is answered from what the server holds before anything
   * asks whether the writer may still create there.
   */
  heldUntitledDocument(
    documentId: string,
  ): Promise<Result<ContextHeldUntitledDocument | null, ContextError>>;

  /** Allocate and persist an empty client-seeded document under a home directory URI. */
  createUntitledDocument(
    homeUri: string,
    options: ContextCreateUntitledDocumentOptions,
  ): Promise<Result<ContextCreateUntitledDocumentResult, ContextError>>;

  /**
   * What this port already holds under a create's client-minted folder id: the folder's place,
   * an id held out of reach, or null. Read-only and unaware of the create's destination, so a
   * replay is answered from what the server holds before anything asks where the writer may
   * create now.
   */
  heldFolder(folderId: string): Promise<Result<ContextHeldFolder | null, ContextError>>;

  /** Create a folder under a device-minted id at the writer's destination. */
  createFolder(
    homeUri: string,
    options: ContextCreateFolderOptions,
  ): Promise<Result<ContextCreateFolderResult, ContextError>>;

  /** Ensure a tracked text document row and empty Yjs document exist without replacing content. */
  ensureTrackedDocument(
    uri: string,
    options?: import("./context-adapter.js").ContextEnsureTrackedOptions,
  ): Promise<Result<ContextEnsureTrackedDocumentResult, ContextError>>;

  /**
   * Reverse a create this port made, for a rolled-back reply or a failed create write
   * (contract §12.5): a live create is deleted; a branch's create ends the branch's use of
   * the document unless the document's draft already holds committed text. A draft-mode
   * port's `delete` never reverses a branch's create.
   */
  retractCreate(
    uri: string,
    options: { documentId: string; cause: RetractionCause },
  ): Promise<Result<void, ContextError>>;

  /** Write a binary (storage-backed) file to a URI. Creates parent folders as needed. */
  writeBinary(
    uri: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<ContextBinaryWriteResult, ContextError>>;

  move(
    sourceUri: string,
    destinationUri: string,
    options?: ContextMoveOptions,
  ): Promise<Result<ContextMoveResult, ContextError>>;

  /**
   * A draft-mode chat's move or delete (D26, D45): facts in its Work's branch, never the
   * shared tree and never the mover. Each end must participate in the branch tree; its content
   * placement may remain live, as Scratch's does. `record` runs in the same transaction. A move
   * to where the branch already has the document answers `moved: false` and records nothing.
   */
  changeInBranch(
    command: ContextBranchTreeCommand,
  ): Promise<Result<ContextBranchTreeResult, ContextError>>;

  /** Commit a file's exact writer-facing identity and end provisional naming. */
  commitWriterLocation(
    sourceUri: string,
    destinationUri: string,
    options?: ContextLocationOptions,
  ): Promise<Result<ContextMoveResult, ContextError>>;

  /** Delete only the initiating file identity or folder kind at this URI. */
  delete(
    uri: string,
    options: ContextDeleteOptions,
  ): Promise<Result<DeleteContextEntryResult, ContextError>>;

  list(uri?: string, options?: ContextListOptions): Promise<Result<ContextListing, ContextError>>;

  /**
   * Create an empty directory at the URI, including any missing ancestors.
   * No-op if the directory already exists. `permission_denied` for read-only
   * schemes.
   */
  mkdir(uri: string, options?: ContextWriteOptions): Promise<Result<void, ContextError>>;

  /**
   * Full-text search.
   *
   * When `uri` names a scheme root (e.g. `kb://`), the search is scoped to
   * that scheme. When omitted, it fans out across searchable schemes.
   */
  search(query: string, uri?: string): Promise<Result<SearchResult[], ContextError>>;
}
