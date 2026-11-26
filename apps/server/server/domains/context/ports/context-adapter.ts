import type { ContextSchemeCapabilities } from "@meridian/contracts/context-uri";
import type { InvalidOperationReason, ParsedDocumentFilename } from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";
import type { TreeJudge, TreeOwners } from "../../../shared/tree-owners.js";
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

export type ContextEnsureTrackedOptions = ContextWriteOptions & {
  parsedFilename?: ParsedDocumentFilename;
  /**
   * The folder node the path's folders mean, as the names the model was shown resolved them: the
   * document goes in it, standing or in Trash (where it brings the folder back), instead of in
   * the folder those names find now.
   */
  into?: string;
  /**
   * A new document at the path even where it reaches one: the model's `create` where the document
   * there holds text makes another document of that name (a twin) instead of refusing.
   */
  beside?: true;
  /** Keeps a newly created document's receipt in the same transaction as its tree placement. */
  recordCreate?: (created: CreatedDocument & { path: string }) => Promise<void>;
};

export type CreatedDocument = {
  documentId: import("@meridian/contracts").DocumentId;
  record: string;
  folders: readonly { record: string; node: string }[];
  draftId?: import("@meridian/contracts").DraftId;
};

export type ContextEnsureTrackedPortOptions = Omit<
  ContextEnsureTrackedOptions,
  "recordCreate" | "parsedFilename"
> & {
  recordCreate?: (created: CreatedDocument & { uri: string }) => Promise<void>;
};

export type SchemeCapabilities = ContextSchemeCapabilities;

export const CONTEXT_SCHEME_CAPABILITIES = {
  manuscript: { writable: true, searchable: true, creatable: true },
  kb: { writable: true, searchable: true, creatable: true },
  user: { writable: true, searchable: true, creatable: true },
  unfiled: { writable: true, searchable: true, creatable: true },
  scratch: { writable: true, searchable: true, creatable: true },
  uploads: { writable: true, searchable: true, creatable: false },
  agents: { writable: true, searchable: true, creatable: true },
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
  | { code: "conflict" }
  | { code: "stale_target" }
  | { code: "invalid_operation"; message?: string; reason?: InvalidOperationReason }
  | {
      code: "context_unavailable";
      reason: "work_archived" | "work_deleted" | "work_missing";
      workHandle: string | null;
    }
  | { code: "io_error"; message: string };

export type AdapterFileEntry = ContextListEntry extends infer T
  ? T extends ContextListEntry
    ? Omit<T, "uri" | "readonly"> & { path: string }
    : never
  : never;

export type AdapterFileRef = FileRef extends infer T
  ? T extends FileRef
    ? Omit<T, "uri" | "readonly"> & { path: string }
    : never
  : never;

export type AdapterGrepFile = Omit<GrepFile, "uri"> & { path: string };
export type AdapterGrepResult = {
  files: AdapterGrepFile[];
  totalFiles: number;
  exact: boolean;
  stopped?: true;
};
export type AdapterContextReadResult = Omit<ContextReadResult, "uri">;
export type AdapterContextWriteResult = Omit<ContextWriteResult, "uri">;

/**
 * A create's answer from the adapter: the source-relative path it landed at, which the router
 * spells as the URI (a twin's leaf carries its `~id`, so it is not always the path asked for).
 */
export type Landed<T> = Omit<T, "uri"> & { path: string };

export type AdapterLocatedDocument = { documentId: string; path: string; name: string };

export type TreeScope = {
  writer: import("@meridian/project-tree").TreeWriter;
  view: import("@meridian/project-tree").View;
  actor: import("@meridian/project-tree").Actor;
  root: string;
};

export type TreeCommandInput<T> = {
  origin?: WriteProvenance;
  drafted?: boolean;
  owners?: TreeOwners;
  /** A refused result stores nothing of what `make` wrote. */
  make: (
    scope: TreeScope,
    judge: TreeJudge,
  ) => { result: T; arrived?: readonly string[]; refused?: boolean };
  afterWrite?: (result: T, scope: Pick<TreeScope, "view">) => Promise<void>;
};

export type TreeReadInput<T> = {
  version?: "draft" | "live";
  read: (scope: Pick<TreeScope, "writer" | "root" | "view">) => T;
};

export interface ContextTreeAdapter {
  sourceId(): Promise<string>;
  /**
   * One command on this source's tree, in the command transaction: live, or (`drafted`) in the
   * Work's draft, which the transaction ensures and locks. `make` decides under the list's lock
   * and returns what it made; `afterWrite` runs inside the transaction once the records exist,
   * so the model's receipt commits with them. `arrived` names the documents the command put
   * at a live address, which settle ahead links.
   */
  command<T>(input: TreeCommandInput<T>): Promise<Result<T, AdapterFault>>;
  read<T>(input: TreeReadInput<T>): Promise<Result<T, AdapterFault>>;
}

export interface ContextSchemeAdapter {
  readonly name: string;
  readonly capabilities: SchemeCapabilities;
  readonly tree?: ContextTreeAdapter;
  readonly copy?: ContextCopyAdapter;

  stat(path: string): Promise<Result<AdapterFileRef | null, AdapterFault>>;
  read(path: string): Promise<Result<AdapterContextReadResult | null, AdapterFault>>;
  write(
    path: string,
    content: string,
    options?: ContextWriteOptions,
  ): Promise<Result<AdapterContextWriteResult, AdapterFault>>;
  bindTrackedDocument(path: string, content: string): Promise<Result<BoundWrite, AdapterFault>>;
  createTrackedDocument(
    path: string,
    markdown: string,
    options?: ContextWriteOptions,
  ): Promise<Result<Landed<ContextCreateTrackedDocumentResult>, AdapterFault>>;
  createBoundDocument(
    path: string,
    bound: BoundWrite | null,
    options?: ContextWriteOptions,
  ): Promise<Result<Landed<ContextCreateTrackedDocumentResult>, AdapterFault>>;
  locateDocument(documentId: string): Promise<Result<AdapterLocatedDocument | null, AdapterFault>>;
  ensureTrackedDocument(
    path: string,
    options?: ContextEnsureTrackedOptions,
  ): Promise<Result<Landed<ContextEnsureTrackedDocumentResult>, AdapterFault>>;
  writeBinary(
    path: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<Landed<ContextBinaryWriteResult>, AdapterFault>>;
  list(
    path: string,
    options?: ContextListOptions,
  ): Promise<Result<AdapterFileEntry[], AdapterFault>>;
  grep(query: GrepQuery): Promise<Result<AdapterGrepResult, AdapterFault>>;
}
