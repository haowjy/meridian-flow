/**
 * Scheme-adapter port: the contract each context scheme implements for router
 * dispatch. Adapters own scheme-local reads/writes/searches; durable ContextFS
 * tree mutation is exposed only through an optional atomic capability.
 * AdapterFault is scope-free and gets URI-enriched at the ContextPort boundary.
 */

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
  /** Keeps a newly created document's receipt in the same transaction as its tree placement. */
  recordCreate?: (created: {
    documentId: import("@meridian/contracts").DocumentId;
    /** The create record, which the receipt names for Undo. */
    record: string;
    /** The Work's branch it was drafted in; absent for a live create. */
    draftBranchId?: import("@meridian/contracts").BranchId;
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

/** One list's copy handed to a tree command: the writer on it, the view it acts in, and the source's top. */
export type TreeScope = {
  writer: import("@meridian/project-tree").TreeWriter;
  view: import("@meridian/project-tree").View;
  actor: import("@meridian/project-tree").Actor;
  root: string;
};

export type TreeCommandInput<T> = {
  origin?: WriteProvenance;
  drafted?: boolean;
  make: (scope: TreeScope) => { result: T; arrived?: readonly string[] };
  afterWrite?: (result: T, scope: Pick<TreeScope, "view">) => Promise<void>;
};

export type TreeReadInput<T> = {
  version?: "draft" | "live";
  read: (scope: Pick<TreeScope, "writer" | "root" | "view">) => T;
};

/** A document that crossed lists: the two records, one in each list, and where it stands now. */
export type AdapterMovedAcrossLists = {
  /** Source-relative path it stands at in the list it entered. */
  path: string;
  /** The ids of the move in the list it left and the create in the list it entered. */
  records: { left: string; entered: string };
  /** The node moved: a document or file. */
  node: string;
};

export type AdapterDeleted = {
  /** Source-relative path it stood at. */
  path: string;
  /** The documents and files the delete took. */
  documentIds: string[];
};

/**
 * Tree writes in one source: records of the source's list. `afterWrite` runs inside the
 * command's transaction once the records are made, so a caller's own entry commits with them.
 */
export interface ContextTreeAdapter {
  /** This adapter's source, provisioned. */
  sourceId(): Promise<string>;
  /**
   * One command on this source's tree, in the command transaction: live, or (`drafted`) in the
   * Work's branch, which the transaction ensures and locks. `make` decides under the list's lock
   * and returns what it made; `afterWrite` runs inside the transaction once the records exist,
   * so the model's receipt commits with them. `arrived` names the documents the command put
   * at a live address, which settle ahead links.
   */
  command<T>(input: TreeCommandInput<T>): Promise<Result<T, AdapterFault>>;
  /** The tree this adapter's source shows the reader: the Work's draft, else live (or live when asked). */
  read<T>(input: TreeReadInput<T>): Promise<Result<T, AdapterFault>>;
  /**
   * A document or file from another list (a project's and the account's `user://`) into `dir` of
   * this source, live: one transaction on both lists. Fails `invalid_operation` for a folder, a
   * Work's draft or a node in this source's own list.
   */
  moveAcrossLists(input: {
    node: ContextEntryRef;
    /** The source the caller found the node in. */
    fromSourceId: string;
    dir: readonly string[];
    /** The name the writer typed; omitted keeps the node's own. */
    leaf?: string;
    position?: ContextSiblingPosition;
    /** Only while the node stands at this source-relative path. */
    onlyAt?: string;
    origin?: WriteProvenance;
    afterWrite?: (moved: AdapterMovedAcrossLists) => Promise<void>;
  }): Promise<Result<AdapterMovedAcrossLists, AdapterFault>>;
  /** Deletes the node and what is inside it, live: one Trash entry. */
  delete(input: {
    node: ContextEntryRef;
    fromSourceId: string;
    /** Only while the node stands at this source-relative path. */
    onlyAt?: string;
    origin?: WriteProvenance;
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
