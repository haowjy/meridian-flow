/**
 * Context port + scheme vocabulary: the stat/read/list/write/search/move/delete
 * contract over context URI schemes plus file-entry, result, and error types.
 */

import type {
  DocumentFileType,
  Filetype,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";

/**
 * Registered context URI schemes.
 *
 * Project-scoped: `manuscript`/`kb`/`user` (bare paths default to `manuscript`).
 * Work-scoped: `work`/`uploads` (authority URIs use `scheme://<workId>/...`).
 */
export type ContextScheme = "manuscript" | "kb" | "work" | "uploads" | "user";

/** Schemes provisioned at project scope in the unified context port. */
export type ProjectContextFsScheme = "manuscript" | "kb" | "user";

/** Schemes provisioned per Work in the unified context port. */
export type WorkScopedContextFsScheme = "work" | "uploads";

export interface ContextReadResult {
  content: string;
  documentId?: string;
}

export interface ContextWriteResult {
  documentId?: string;
  markdown?: string;
  updateSeq?: number;
}

interface BaseListEntry {
  uri: string;
  documentId?: string;
  sizeBytes?: number;
  updatedAt?: string;
  /** True when the entry's scheme is read-only. */
  readonly?: boolean;
}

export type EditableFileEntry = BaseListEntry & {
  kind: "file";
  editable: true;
  filetype: Filetype;
  schemaType: YjsTrackedSchemaType;
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

/** A single full-text search match returned by {@link ContextPort.search}. */
export interface SearchResult {
  /** Canonical `scheme://path` URI of the matched file. */
  uri: string;
  /** Matched line or snippet. */
  excerpt: string;
  /** 1-based line number within the file, if applicable. */
  line?: number;
  /** Relevance score, 0-1. Adapter-dependent. */
  score?: number;
}

/**
 * Errors surfaced across the ContextPort boundary. Every variant carries the
 * canonical `uri` it concerns so callers can report without re-parsing.
 */
export type ContextError =
  | { code: "not_found"; uri: string }
  | { code: "permission_denied"; uri: string }
  | { code: "conflict"; uri: string }
  | { code: "invalid_operation"; uri: string }
  | { code: "context_unavailable"; uri: string }
  | { code: "invalid_uri"; uri: string; reason: string }
  | { code: "io_error"; uri: string; message: string };

export type WriteProvenance =
  | { type: "agent"; agentSlug: string; threadId: string; turnId: string }
  | { type: "human"; userId: string; threadId?: string }
  | { type: "import"; userId: string; source: string; filename: string; sourceId?: string }
  | { type: "system" };

export interface ContextWriteOptions {
  origin?: WriteProvenance;
}

export interface ContextMoveOptions extends ContextWriteOptions {
  overwrite?: boolean;
}

export interface ContextMoveResult {
  movedNodeId?: string;
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
   * Atomically read, transform, and write tracked text content under the
   * document collab mutex. Only supported for editable tracked files.
   */
  edit(
    uri: string,
    transform: (content: string) => string,
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

  delete(uri: string, options?: ContextWriteOptions): Promise<Result<void, ContextError>>;

  list(uri: string): Promise<Result<ContextListEntry[], ContextError>>;

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
