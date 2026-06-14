/**
 * Context port + scheme vocabulary: the stat/read/list/write/search contract over the
 * four context URI schemes (`fs1`/`kb`/`work`/`user`) plus the file-entry,
 * result, and error types. The boundary the router implements and other domains depend on.
 */

import type {
  DocumentFileType,
  Filetype,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";

/**
 * The four registered context URI schemes.
 *
 * - `fs1`     — project files (uploaded data, generated outputs). Bare paths default here.
 * - `kb`      — project knowledge base (agent-maintained).
 * - `work`    — per-work scratchpad / working memory.
 * - `user`    — user-scoped file tree, cross-project.
 */
export type ContextScheme = "fs1" | "kb" | "work" | "user";

export interface ContextReadResult {
  content: string;
  /** Persisted document row id for ContextFS-backed files (`fs1`, `kb`, `work`, `user`). */
  documentId?: string;
}

export interface ContextWriteResult {
  /** Persisted document row id for ContextFS-backed files (`fs1`, `kb`, `work`, `user`). */
  documentId?: string;
}

interface BaseListEntry {
  /** Canonical `scheme://path` URI of the entry. */
  uri: string;
  /** Persisted document row id for ContextFS-backed files (`fs1`, `kb`, `work`, `user`). */
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
  /** Canonical `scheme://path` URI of the file. */
  uri: string;
  /** Persisted document row id for ContextFS-backed files (`fs1`, `kb`, `work`, `user`). */
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
  | { code: "context_unavailable"; uri: string }
  | { code: "invalid_uri"; uri: string; reason: string }
  | { code: "io_error"; uri: string; message: string };

export type WriteProvenance =
  | { type: "agent"; agentSlug: string; threadId: string; turnId: string }
  | { type: "human"; userId: string }
  | { type: "import"; userId: string; source: string; filename: string; sourceId?: string }
  | { type: "system" };

export interface ContextWriteOptions {
  /**
   * Attribution for content writes. ContextFS documents persist this into
   * the Yjs update log; adapters that do not support attribution may ignore it.
   */
  origin?: WriteProvenance;
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

  /** Write a binary (storage-backed) file to a URI. Creates parent folders as needed. */
  writeBinary(
    uri: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<ContextWriteResult, ContextError>>;

  /** List direct children of a URI prefix. Empty array if the prefix is absent. */
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
