/**
 * Scheme-adapter port: the contract each context scheme implements for router
 * dispatch. Adapters own scheme-local reads/writes/searches; durable ContextFS
 * tree mutation is exposed only through an optional atomic capability.
 * AdapterFault is scope-free and gets URI-enriched at the ContextPort boundary.
 */

import type { ContextSchemeCapabilities } from "@meridian/contracts/context-uri";
import type {
  DeleteContextEntryResult,
  Filetype,
  InvalidOperationReason,
  NamespaceNameClaim,
  ParsedDocumentFilename,
  RetractionCause,
} from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";
import type { BoundWrite } from "../../collab/index.js";
import type { BranchChangeAuthor, RecordedBranchTreeChange } from "./branch-tree.js";
import type {
  AdapterCreateUntitledOptions,
  ContextBinaryWriteResult,
  ContextCreateTrackedDocumentResult,
  ContextEnsureTrackedDocumentResult,
  ContextListEntry,
  ContextListOptions,
  ContextReadResult,
  ContextScheme,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  ContextWriteResult,
  FileRef,
  SearchResult,
} from "./context-port.js";
import type {
  ContextLocationToken,
  ContextTreeDeleteCommand,
  PreparedContextMove,
} from "./context-tree-mutation-store.js";

/** The router resolves destination inheritance once; direct adapter callers may supply raw input. */
export type ContextEnsureTrackedOptions = ContextWriteOptions & {
  parsedFilename?: ParsedDocumentFilename;
  /** Records a newly created document in the same transaction as its tree placement. */
  recordCreate?: (created: {
    documentId: import("@meridian/contracts").DocumentId;
    change:
      | { destination: "live"; before: null }
      | ({ destination: "draft"; branchId: import("@meridian/contracts").BranchId } & Pick<
          import("@meridian/contracts").BranchTreeTransition,
          "before" | "after"
        >);
  }) => Promise<void>;
};

/** What a scheme adapter supports. Checked by the router before dispatch. */
export type SchemeCapabilities = ContextSchemeCapabilities;

export const CONTEXT_SCHEME_CAPABILITIES = {
  manuscript: { writable: true, searchable: true, creatable: true },
  kb: { writable: true, searchable: true, creatable: true },
  user: { writable: true, searchable: true, creatable: true },
  unfiled: { writable: true, searchable: true, creatable: true },
  scratch: { writable: true, searchable: true, creatable: true },
  uploads: { writable: true, searchable: true, creatable: false },
} as const satisfies Readonly<Record<ContextScheme, SchemeCapabilities>>;

export function schemeCapabilities(scheme: ContextScheme): SchemeCapabilities {
  return CONTEXT_SCHEME_CAPABILITIES[scheme];
}

/**
 * A fault raised by an adapter. Unlike {@link ContextError} it carries no
 * `uri` — the router owns the canonical URI and enriches the fault into a
 * {@link ContextError} at the boundary.
 *
 * Not-found on read is modelled as `Ok(null)`, not a fault.
 */
export type AdapterFault =
  | { code: "invalid_name"; message: string }
  | { code: "not_found" }
  | { code: "destination_missing" }
  | { code: "permission_denied" }
  | { code: "conflict"; occupantKind?: "file" | "folder" }
  | { code: "stale_source" }
  | { code: "stale_target" }
  | { code: "invalid_operation"; message?: string; reason?: InvalidOperationReason }
  | {
      code: "context_unavailable";
      reason: "work_archived" | "work_deleted" | "work_missing";
      workHandle: string | null;
    }
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
export type AdapterContextReadResult = Omit<ContextReadResult, "uri">;
export type AdapterContextWriteResult = Omit<ContextWriteResult, "uri">;

export type AdapterUntitledDocumentResult = {
  status: "created" | "already-exists" | "joined";
  documentId: string;
  path: string;
  name: string;
};

export type AdapterLocatedDocument = Omit<AdapterUntitledDocumentResult, "status">;

export type AdapterMoveResult = {
  linkUpdate?: { links: number; documents: number };
  movedNodeId?: string;
  path: string;
  locationVersion?: string;
};

export type AdapterDeleteResult = {
  removed: DeleteContextEntryResult["removed"];
  availabilityGeneration: string;
};

export interface ContextTreeAdapter {
  inspectMovable(path: string): Promise<Result<ContextLocationToken | null, AdapterFault>>;
  commitProvisionalGraduation(
    source: Extract<ContextLocationToken, { kind: "file" }>,
  ): Promise<Result<void, AdapterFault>>;
  commitPreparedMove(
    prepared: PreparedContextMove,
  ): Promise<Result<AdapterMoveResult, AdapterFault>>;
  commitRecursiveDelete(
    command: ContextTreeDeleteCommand,
  ): Promise<Result<AdapterDeleteResult, AdapterFault>>;
}

/**
 * A draft placement's moves and deletes in its Work's branch (D26): facts on the branch's
 * row, never live. `record` runs in the same transaction, after the row is written.
 */
export interface ContextBranchTreeAdapter {
  /** This adapter's source, provisioned. */
  sourceId(): Promise<string>;
  /**
   * `moved: false` when the branch already has it at `path`: nothing is written. `path` is
   * the destination as stored (an extensionless name keeps the document's extension).
   */
  move(
    path: string,
    input: {
      documentId: string;
      /** Where the branch has it now: its path and filetype there, and that source. */
      from: { path: string; filetype: Filetype | null; sourceId: string };
      changedBy: BranchChangeAuthor;
      record(change: RecordedBranchTreeChange): Promise<void>;
      position?: import("@meridian/contracts/protocol").ContextSiblingPosition;
    },
  ): Promise<Result<{ moved: boolean; path: string }, AdapterFault>>;
  delete(
    path: string,
    input: {
      documentId: string;
      changedBy: BranchChangeAuthor;
      record(change: RecordedBranchTreeChange): Promise<void>;
    },
  ): Promise<Result<void, AdapterFault>>;
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
  /** Only a draft placement has one. */
  readonly branchTree?: ContextBranchTreeAdapter;

  stat(path: string): Promise<Result<AdapterFileRef | null, AdapterFault>>;
  read(path: string): Promise<Result<AdapterContextReadResult | null, AdapterFault>>;
  write(
    path: string,
    content: string,
    options?: ContextWriteOptions,
  ): Promise<Result<AdapterContextWriteResult, AdapterFault>>;
  /** Bind content for a document about to be created at `path`, outside any transaction. */
  bindTrackedDocument(path: string, content: string): Promise<Result<BoundWrite, AdapterFault>>;
  createTrackedDocument(
    path: string,
    markdown: string,
    options?: ContextWriteOptions,
  ): Promise<Result<Omit<ContextCreateTrackedDocumentResult, "uri">, AdapterFault>>;
  createTrackedDocumentAtFreeName(
    path: string,
    markdown: string,
    reserved: readonly NamespaceNameClaim[],
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string; path: string }, AdapterFault>>;
  createBoundDocument(
    path: string,
    bound: BoundWrite | null,
    options?: ContextWriteOptions,
  ): Promise<Result<Omit<ContextCreateTrackedDocumentResult, "uri">, AdapterFault>>;
  /** Find an active document owned by this adapter's source. */
  /** `includeDeleted` also answers a soft-deleted document's last address. */
  locateDocument(
    documentId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Result<AdapterLocatedDocument | null, AdapterFault>>;
  createUntitledDocument(
    path: string,
    options: AdapterCreateUntitledOptions,
  ): Promise<Result<AdapterUntitledDocumentResult, AdapterFault>>;
  ensureTrackedDocument(
    path: string,
    options?: ContextEnsureTrackedOptions,
  ): Promise<Result<Omit<ContextEnsureTrackedDocumentResult, "uri">, AdapterFault>>;
  /**
   * Reverse this adapter's create of `documentId` (contract §12.5): a draft placement
   * retracts the branch's use itself; `live` asks the caller to delete the document.
   */
  retractCreate(
    path: string,
    documentId: string,
    cause: RetractionCause,
  ): Promise<Result<{ placement: "live" | "draft" }, AdapterFault>>;
  writeBinary(
    path: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<Omit<ContextBinaryWriteResult, "uri">, AdapterFault>>;
  list(
    path: string,
    options?: ContextListOptions,
  ): Promise<Result<AdapterFileEntry[], AdapterFault>>;
  mkdir(path: string, options?: ContextWriteOptions): Promise<Result<void, AdapterFault>>;
  search(query: string, pathPrefix?: string): Promise<Result<AdapterSearchHit[], AdapterFault>>;
}
