/**
 * Scheme-adapter port: the contract each context scheme implements for router
 * dispatch. Adapters own scheme-local reads/writes/searches; durable ContextFS
 * tree mutation is exposed only through an optional atomic capability.
 * AdapterFault is scope-free and gets URI-enriched at the ContextPort boundary.
 */

import type { BranchId, BranchTreeFacts } from "@meridian/contracts";
import type { ContextSchemeCapabilities } from "@meridian/contracts/context-uri";
import type {
  ContextEntryRef,
  ContextSiblingPosition,
  InvalidOperationReason,
  ParsedDocumentFilename,
  RetractionCause,
} from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";
import type { BoundWrite } from "../../collab/index.js";
import type { ContextCopyAdapter } from "./context-copy.js";
import type {
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
  GrepFile,
  GrepQuery,
  WriteProvenance,
} from "./context-port.js";

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

/** A grep hit as produced by an adapter: `uri` is a scheme-relative path. */
export type AdapterGrepFile = Omit<GrepFile, "uri"> & { path: string };
export type AdapterGrepResult = {
  files: AdapterGrepFile[];
  totalFiles: number;
  exact: boolean;
  stopped?: true;
};
export type AdapterContextReadResult = Omit<ContextReadResult, "uri">;
export type AdapterContextWriteResult = Omit<ContextWriteResult, "uri">;

export type AdapterLocatedDocument = { documentId: string; path: string; name: string };

/** A drafted tree write's branch and the node's facts in it on either side, for the edit history. */
export type AdapterDraftedChange = {
  branchId: BranchId;
  before: BranchTreeFacts;
  after: BranchTreeFacts;
};

export type AdapterMoved = {
  /** False when the node already stood there: nothing was written. */
  moved: boolean;
  /** Source-relative path it stands at. */
  path: string;
  drafted?: AdapterDraftedChange;
};

export type AdapterDeleted = {
  /** Source-relative path it stood at. */
  path: string;
  /** The documents and files the delete took. */
  documentIds: string[];
  drafted?: AdapterDraftedChange;
};

/**
 * Moves and deletes in one source: records of the project's list, live or (`drafted`) of the
 * Work's branch, which the command transaction ensures and locks. `afterWrite` runs inside the
 * command's transaction once the records are made, so a caller's own entry commits with them.
 */
export interface ContextTreeAdapter {
  /** This adapter's source, provisioned. */
  sourceId(): Promise<string>;
  /** Moves and renames into `dir` of this adapter's source; null keeps the node's own folder. */
  move(input: {
    node: ContextEntryRef;
    /** The source the caller found the node in. */
    fromSourceId: string;
    dir: readonly string[] | null;
    /** The name the writer typed; omitted keeps the node's own. */
    leaf?: string;
    position?: ContextSiblingPosition;
    origin?: WriteProvenance;
    drafted?: boolean;
    afterWrite?: (moved: AdapterMoved) => Promise<void>;
  }): Promise<Result<AdapterMoved, AdapterFault>>;
  delete(input: {
    node: ContextEntryRef;
    fromSourceId: string;
    /** Only while the node stands at this source-relative path. */
    onlyAt?: string;
    origin?: WriteProvenance;
    drafted?: boolean;
    afterWrite?: (deleted: AdapterDeleted) => Promise<void>;
  }): Promise<Result<AdapterDeleted, AdapterFault>>;
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
  /** Copy's source read and destination insert (`context/copy/` orchestrates a drop). */
  readonly copy?: ContextCopyAdapter;

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
  createBoundDocument(
    path: string,
    bound: BoundWrite | null,
    options?: ContextWriteOptions,
  ): Promise<Result<Omit<ContextCreateTrackedDocumentResult, "uri">, AdapterFault>>;
  /** Find an active document owned by this adapter's source. */
  locateDocument(documentId: string): Promise<Result<AdapterLocatedDocument | null, AdapterFault>>;
  ensureTrackedDocument(
    path: string,
    options?: ContextEnsureTrackedOptions,
  ): Promise<Result<Omit<ContextEnsureTrackedDocumentResult, "uri">, AdapterFault>>;
  /** Reverse this adapter's create of `documentId` (contract §12.5): live goes to Trash, a draft is discarded. */
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
  grep(query: GrepQuery): Promise<Result<AdapterGrepResult, AdapterFault>>;
}
