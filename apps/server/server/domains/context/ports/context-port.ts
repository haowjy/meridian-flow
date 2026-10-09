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
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import type { SpelledLinkFact } from "@meridian/markup";
import type { Result } from "../../../shared/result.js";
import type { PreparedWrite } from "../../collab/index.js";
import type { WorkRef } from "../../file-policy/index.js";
import type { DocumentCreationMetadata } from "../document-metadata.js";

/**
 * Registered context URI schemes.
 *
 * Project-scoped: `manuscript`/`kb`/`user` (bare paths default to `manuscript`).
 * Work-scoped: `scratch`/`uploads` (wire qualifiers use `scheme://@<work-slug>/...`).
 */
export type { ContextError, ContextMoveResult } from "@meridian/contracts/protocol";
export type ContextScheme = ContextUriScheme;

/**
 * How one thread reads every source through its port. Reads follow the
 * version that thread's writes change, per document (D14, D20), or the
 * live text, without draft changes, when `version` is `live`.
 */
export interface ThreadContextView {
  threadId: string;
  /** The reply in progress, whose own staged writes reads still see. */
  responseId?: string | null;
  /** The Work whose draft this thread's drafted writes land in; null outside draft mode (D40). */
  draftWork: WorkRef | null;
  version?: "draft" | "live";
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

export interface ContextEnsureTrackedDocumentResult {
  uri: string;
  documentId: string;
  created: boolean;
}

export interface ContextCreateTrackedDocumentResult {
  documentId: string;
}

export type ContextCreateUntitledDocumentResult =
  | {
      status: "created";
      documentId: string;
      path: string;
      name: string;
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

export interface ContextCreateUntitledDocumentOptions {
  documentId: string;
  origin: WriteProvenance;
}

interface BaseListEntry {
  uri: string;
  documentId?: string;
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
   * Host-only: each ref-bearing link the returned passages spell, as spelled,
   * computed after the passage cap. Tools strip it; the host records it as shown
   * only for hits the reader may see.
   */
  shownLinks?: readonly SpelledLinkFact[];
  /** Host-only: the view `shownLinks` were spelled in. */
  shownView?: LinkView;
}

export type WriteProvenance =
  | { type: "agent"; agentSlug: string; threadId: string; turnId: string }
  | { type: "human"; userId: string; threadId?: string }
  | { type: "import"; userId: string; source: string; filename: string; sourceId?: string }
  | { type: "system" };

export interface ContextWriteOptions {
  origin?: WriteProvenance;
  /** Stable identity reserved by an authoritative aggregate before content creation. */
  documentId?: string;
  /**
   * Create only the context row for a tracked document; the caller must ensure
   * the live Y.Doc before committed content is applied.
   */
  deferDocumentSync?: boolean;
  /** Recorded in `documents.metadata` when this call creates the document; never on an existing one. */
  metadata?: DocumentCreationMetadata;
}

export interface ContextLocationOptions extends ContextWriteOptions {
  operationId?: string;
  expected?: MoveContextEntryRequest["expected"];
}

export interface ContextMoveOptions extends ContextWriteOptions {
  overwrite?: boolean;
}

export interface ContextDeleteOptions extends ContextWriteOptions {
  operationId?: string;
  expected: DeleteContextEntryRequest["expected"];
}

/** Certified context edits are closed semantic commands, never opaque callbacks. */
export type ContextEditCommand = { kind: "append"; content: string };

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

  /** Write text content to a URI, creating parent folders as needed. */
  write(
    uri: string,
    content: string,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextWriteResult, ContextError>>;

  /**
   * Prepare content for a tracked document about to be created at `uri`.
   * Runs outside any transaction (it may register ahead refs); a caller that
   * creates inside its own transaction prepares first (contract §6.2).
   */
  prepareTrackedDocument(
    uri: string,
    content: string,
  ): Promise<Result<PreparedWrite, ContextError>>;

  /**
   * Claim and seed a new tracked URI without ever replacing an existing path.
   * Text content is prepared here, so only prepared content may be passed
   * inside a transaction.
   */
  createTrackedDocument(
    uri: string,
    content: string | PreparedWrite,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextCreateTrackedDocumentResult, ContextError>>;

  /** Allocate and persist an empty client-seeded document under a home directory URI. */
  createUntitledDocument(
    homeUri: string,
    options: ContextCreateUntitledDocumentOptions,
  ): Promise<Result<ContextCreateUntitledDocumentResult, ContextError>>;

  /** Ensure a tracked text document row and empty Yjs document exist without replacing content. */
  ensureTrackedDocument(
    uri: string,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextEnsureTrackedDocumentResult, ContextError>>;

  /**
   * Resolve and apply one semantic edit under the document collab mutex.
   */
  edit(
    uri: string,
    command: ContextEditCommand,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextWriteResult, ContextError>>;

  /** Write a binary (storage-backed) file to a URI. Creates parent folders as needed. */
  writeBinary(
    uri: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<ContextWriteResult, ContextError>>;

  move(
    sourceUri: string,
    destinationUri: string,
    options?: ContextMoveOptions,
  ): Promise<Result<ContextMoveResult, ContextError>>;

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
