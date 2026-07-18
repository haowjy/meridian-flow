/**
 * Scheme-adapter port: the contract each context scheme implements for router
 * dispatch. Adapters own scheme-local reads/writes/searches; durable ContextFS
 * tree mutation is exposed only through an optional atomic capability.
 * AdapterFault is scope-free and gets URI-enriched at the ContextPort boundary.
 */
import type { Result } from "../../../shared/result.js";
import type {
  ContextCreateTrackedDocumentResult,
  ContextCreateUntitledDocumentOptions,
  ContextCreateUntitledDocumentResult,
  ContextEditCommand,
  ContextEnsureTrackedDocumentResult,
  ContextListEntry,
  ContextReadResult,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  ContextWriteResult,
  FileRef,
  SearchResult,
} from "./context-port.js";
import type { ContextLocationToken, PreparedContextMove } from "./context-tree-mutation-store.js";

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
  | { code: "conflict" }
  | { code: "stale_source" }
  | { code: "stale_target" }
  | { code: "invalid_operation"; message?: string }
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

export type AdapterMoveResult = {
  movedNodeId?: string;
  path: string;
};

export type AdapterDeleteResult = {
  deletedNodeId?: string;
};

export interface ContextTreeAdapter {
  inspectMovable(path: string): Promise<Result<ContextLocationToken | null, AdapterFault>>;
  commitProvisionalGraduation(
    source: Extract<ContextLocationToken, { kind: "file" }>,
  ): Promise<Result<void, AdapterFault>>;
  commitPreparedMove(
    prepared: PreparedContextMove,
  ): Promise<Result<AdapterMoveResult, AdapterFault>>;
  commitPreparedDelete(
    token: ContextLocationToken,
  ): Promise<Result<AdapterDeleteResult, AdapterFault>>;
}

/**
 * The reduced surface each scheme is backed by. The adapter never parses URIs
 * or validates schemes — it receives pre-parsed, normalized paths from the
 * router. It returns scheme-relative paths; the router re-attaches the scheme.
 */
export interface ContextSchemeAdapter {
  readonly name: string;
  readonly capabilities: SchemeCapabilities;
  readonly tree?: ContextTreeAdapter;

  stat(path: string): Promise<Result<AdapterFileRef | null, AdapterFault>>;
  read(path: string): Promise<Result<ContextReadResult | null, AdapterFault>>;
  write(
    path: string,
    content: string,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextWriteResult, AdapterFault>>;
  createTrackedDocument(
    path: string,
    content: string,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextCreateTrackedDocumentResult, AdapterFault>>;
  createUntitledDocument(
    path: string,
    options: ContextCreateUntitledDocumentOptions,
  ): Promise<Result<ContextCreateUntitledDocumentResult, AdapterFault>>;
  ensureTrackedDocument(
    path: string,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextEnsureTrackedDocumentResult, AdapterFault>>;
  edit(
    path: string,
    command: ContextEditCommand,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextWriteResult, AdapterFault>>;
  writeBinary(
    path: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<ContextWriteResult, AdapterFault>>;
  list(path: string): Promise<Result<AdapterFileEntry[], AdapterFault>>;
  mkdir(path: string, options?: ContextWriteOptions): Promise<Result<void, AdapterFault>>;
  search(query: string, pathPrefix?: string): Promise<Result<AdapterSearchHit[], AdapterFault>>;
}
