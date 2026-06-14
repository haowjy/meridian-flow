/**
 * Scheme-adapter port: the contract each context scheme (`fs1`, `kb`, `work`,
 * `user`) implements for the router to dispatch reads/writes/searches. Owns the
 * capability flags and the scope-free AdapterFault type that the router enriches
 * into a ContextError at the boundary.
 */
import type { Result } from "../../../shared/result.js";
import type {
  ContextListEntry,
  ContextReadResult,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  ContextWriteResult,
  FileRef,
  SearchResult,
} from "./context-port.js";

/** What a scheme adapter supports. Checked by the router before dispatch. */
export interface SchemeCapabilities {
  readonly writable: boolean;
  readonly searchable: boolean;
}

/**
 * A fault raised by an adapter. Unlike {@link ContextError} it carries no
 * `uri` — the router owns the canonical URI and enriches the fault into a
 * {@link ContextError} at the boundary.
 *
 * Not-found on read is modelled as `Ok(null)`, not a fault.
 */
export type AdapterFault =
  | { code: "permission_denied" }
  | { code: "context_unavailable" }
  | { code: "io_error"; message: string };

/** A listing entry as produced by an adapter: `uri` is a scheme-relative path. */
export type AdapterFileEntry = ContextListEntry extends infer T
  ? T extends ContextListEntry
    ? Omit<T, "uri" | "readonly"> & { path: string }
    : never
  : never;

/** A single-file ref as produced by an adapter: `uri` is a scheme-relative path. */
export type AdapterFileRef = FileRef extends infer T
  ? T extends FileRef
    ? Omit<T, "uri" | "readonly"> & { path: string }
    : never
  : never;

/** A search hit as produced by an adapter: `uri` is a scheme-relative path. */
export type AdapterSearchHit = Omit<SearchResult, "uri"> & { path: string };

/**
 * The reduced surface each scheme is backed by. The adapter never parses URIs
 * or validates schemes — it receives pre-parsed, normalized paths from the
 * router. It returns scheme-relative paths; the router re-attaches the scheme.
 */
export interface ContextSchemeAdapter {
  /** Human-readable name for logging and errors. */
  readonly name: string;

  /** What this adapter supports. */
  readonly capabilities: SchemeCapabilities;

  /** Resolve one file. `Ok(null)` means not found or the path names a directory. */
  stat(path: string): Promise<Result<AdapterFileRef | null, AdapterFault>>;

  /** Read file content. `Ok(null)` means not found. */
  read(path: string): Promise<Result<ContextReadResult | null, AdapterFault>>;

  /** Write text content. Only called when `capabilities.writable`. */
  write(
    path: string,
    content: string,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextWriteResult, AdapterFault>>;

  /** Write a binary file. Only called when `capabilities.writable`. */
  writeBinary(
    path: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<ContextWriteResult, AdapterFault>>;

  /** List direct children of a path prefix. Empty array when absent. */
  list(path: string): Promise<Result<AdapterFileEntry[], AdapterFault>>;

  /**
   * Create an empty directory, including any missing ancestors. No-op if it
   * already exists. Only called when `capabilities.writable`.
   */
  mkdir(path: string, options?: ContextWriteOptions): Promise<Result<void, AdapterFault>>;

  /**
   * Full-text search within this scheme. Only called when
   * `capabilities.searchable`. `pathPrefix` optionally scopes the search.
   */
  search(query: string, pathPrefix?: string): Promise<Result<AdapterSearchHit[], AdapterFault>>;
}
