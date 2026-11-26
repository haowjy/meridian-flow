import type { DraftId, LinkView, StoredDocumentProperties } from "@meridian/contracts";
import type {
  ContextUriScheme,
  ProjectScopedContextUriScheme,
  WorkScopedContextUriScheme,
} from "@meridian/contracts/context-uri";
import type {
  ContextDestinationParent,
  ContextError,
  ContextSiblingPosition,
  CopyContextEntriesResult,
  DocumentFileType,
  Filetype,
  TrackedSchemaType,
} from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { SpelledLinkFact } from "@meridian/markup/links";
import type { Result } from "../../../shared/result.js";
import type { BoundWrite } from "../../collab/index.js";
import type { DraftOwnerRef, FileDestination } from "../../file-policy/index.js";
import type { DocumentCreationMetadata } from "../document-metadata.js";
import type { AddressGlob } from "../grep/address-glob.js";
import type { GrepMatcher } from "../grep/matcher.js";
import type { TreeCommandInput, TreeReadInput } from "./context-adapter.js";
import type { ContextCommandDraft } from "./context-command-transaction.js";

export type { ContextError } from "@meridian/contracts/protocol";
export type ContextScheme = ContextUriScheme;

/**
 * How one thread reads every source through its port. Reads follow the
 * version that thread's writes change, per document, or the
 * live text, without draft changes, when `version` is `live`.
 */
export interface ThreadContextView {
  scratchOwner?: import("../scratch-owner.js").ScratchOwner;
  uploadsOwner?: UploadsOwner;
  threadId: string;
  draftOwner: DraftOwnerRef;
  writeMode: AiWriteMode;
  /**
   * Where every write of this port lands, when its caller already knows: a person's write, an
   * Undo, a tool call holding its grants. Absent, the chat's write mode and each place's AI
   * access decide.
   */
  destination?: FileDestination;
  version?: "draft" | "live";
}

export interface UploadsOwner {
  chatId: string;
  chatRef: string | null;
}

export type ProjectContextFsScheme = ProjectScopedContextUriScheme;

export type WorkScopedContextFsScheme = WorkScopedContextUriScheme;

export interface ContextReadResult {
  uri: string;
  content: string;
  documentId?: string;
}

export interface ContextWriteResult {
  uri: string;
  documentId?: string;
  markdown?: string;
}

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

interface BaseListEntry {
  uri: string;
  title?: string | null;
  documentId?: string;
  folderId?: string;
  sizeBytes?: number;
  updatedAt?: string;
  readonly?: boolean;
  provisionalName?: boolean;
}

export type EditableFileEntry = BaseListEntry & {
  kind: "file";
  editable: true;
  filetype: Filetype;
  schemaType: TrackedSchemaType;
  /** Words as the current derivation counted them; set only when {@link ContextListOptions.wordCounts} asks and the derivation is current. */
  wordCount?: number;
};

export type BinaryFileEntry = BaseListEntry & {
  kind: "file";
  editable: false;
  fileType: DocumentFileType;
  mimeType: string;
};

export type DirectoryEntry = BaseListEntry & { kind: "directory" };

export type ContextFileEntry = EditableFileEntry | BinaryFileEntry;
export type ContextListEntry = DirectoryEntry | ContextFileEntry;
export type FileEntry = ContextListEntry;

export interface ContextListing {
  uri: string | null;
  entries: ContextListEntry[];
}

export interface ContextListOptions {
  wordCounts?: boolean;
}

interface BaseFileRef {
  uri: string;
  documentId?: string;
  sizeBytes?: number;
  updatedAt?: string;
  readonly?: boolean;
  /**
   * Imported frontmatter stored with the document; `copy` carries it to the copy.
   * Host-only: the model never sees properties in v1 (#778). Copy
   * inheriting metadata is not model visibility; no tool output may render this.
   */
  properties?: StoredDocumentProperties;
  aliases?: string[];
}

export interface TrackedFileRef extends BaseFileRef {
  kind: "tracked";
  filetype: Filetype;
  schemaType: TrackedSchemaType;
}

export interface BinaryFileRef extends BaseFileRef {
  kind: "binary";
  fileType: DocumentFileType;
  extension: string;
  storageUrl: string;
  mimeType: string;
  hasPreview?: boolean;
}

export type FileRef = TrackedFileRef | BinaryFileRef;

export interface GrepPassage {
  excerpt: string;
  blockHash?: string;
  anchor?: { start: number; end: number };
  term?: string;
}

export interface GrepShowing {
  holderUri: string;
  view: LinkView;
  passages: readonly (readonly SpelledLinkFact[])[];
}

export interface GrepFile {
  documentId: string;
  revision: string | null;
  uri: string;
  readonly: boolean;
  matches: GrepPassage[];
  matchCount?: number;
  shown?: GrepShowing;
}

export type GrepMode = "content" | "files_with_matches" | "count";

export interface GrepQuery {
  matcher: GrepMatcher;
  path?: string;
  glob?: AddressGlob;
  mode: GrepMode;
  headLimit: number;
  signal: AbortSignal;
  readable(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { level: "read" | "edit"; destination: FileDestination }>>;
}

export interface GrepResult {
  files: GrepFile[];
  totalFiles: number;
  exact: boolean;
  stopped?: true;
}

export type CopySourceView = { kind: "live" } | { kind: "draft"; draft: DraftId };

export interface ContextCopyRequest {
  operationId: string;
  sources: readonly {
    uri: string;
    view?: CopySourceView;
    expected: { kind: "file" | "folder"; nodeId: string };
    copyId?: string;
    roomVersion?: Uint8Array;
  }[];
  destinationUri: string;
  destinationDraft?: ContextCommandDraft;
  destinationParent?: ContextDestinationParent;
  position?: ContextSiblingPosition;
  authorizeDestination?: (uri: string) => Promise<boolean>;
}

export type WriteProvenance =
  | { type: "agent"; agentSlug: string | null; threadId: string; turnId: string }
  | { type: "human"; userId: string; threadId?: string }
  | { type: "import"; userId: string; source: string; filename: string; sourceId?: string }
  | { type: "system" };

export interface ContextWriteOptions {
  sourceExtension?: string;
  origin?: WriteProvenance;
  documentId?: string;
  metadata?: DocumentCreationMetadata;
}

export interface ContextWriteBinaryOptions extends ContextWriteOptions {
  fileType: DocumentFileType;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  hasPreview?: boolean;
  filename?: { name: string; extension: string };
}

export interface ContextPort {
  copy(request: ContextCopyRequest): Promise<Result<CopyContextEntriesResult, ContextError>>;
  leftOutForMissingFolder(
    request: ContextCopyRequest,
  ): Promise<Result<CopyContextEntriesResult, ContextError>>;

  resolveFolderUri(
    uri: string,
    view?: CopySourceView,
  ): Promise<Result<{ uri: string }, ContextError>>;

  stat(uri: string): Promise<Result<FileRef, ContextError>>;

  read(uri: string): Promise<Result<ContextReadResult, ContextError>>;

  write(
    uri: string,
    content: string,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextWriteResult, ContextError>>;

  bindTrackedDocument(uri: string, content: string): Promise<Result<BoundWrite, ContextError>>;

  createTrackedDocument(
    uri: string,
    markdown: string,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextCreateTrackedDocumentResult, ContextError>>;

  createBoundDocument(
    uri: string,
    bound: BoundWrite | null,
    options?: ContextWriteOptions,
  ): Promise<Result<ContextCreateTrackedDocumentResult, ContextError>>;

  locate(
    documentId: string,
  ): Promise<Result<{ documentId: string; uri: string } | null, ContextError>>;

  ensureTrackedDocument(
    uri: string,
    options?: import("./context-adapter.js").ContextEnsureTrackedPortOptions,
  ): Promise<Result<ContextEnsureTrackedDocumentResult, ContextError>>;

  writeBinary(
    uri: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<ContextBinaryWriteResult, ContextError>>;

  treeCommand<T>(area: string, input: TreeCommandInput<T>): Promise<Result<T, ContextError>>;

  readTree<T>(area: string, input: TreeReadInput<T>): Promise<Result<T, ContextError>>;

  list(uri?: string, options?: ContextListOptions): Promise<Result<ContextListing, ContextError>>;

  grep(query: GrepQuery): Promise<Result<GrepResult, ContextError>>;
}
