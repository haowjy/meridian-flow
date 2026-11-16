/**
 * Reads of one ContextFS context source's tree: documents and folders as a view shows them.
 *
 * The tree is written by the project's list (`tree-list-store`), never through this store: a
 * create, move or delete is a record made at the call (`context-fs/tree-writes.ts`), and the
 * rows this store reads are the list's replay. `parentId`/`folderId` of `null` denotes the
 * source root.
 */
import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
import type { PathResolution, TreeView } from "../tree/tree-view.js";

export interface ContextFolder {
  id: string;
  parentId: string | null;
  name: string;
  /** Its path segment: the name, and a later twin's `~` suffix. A path joins these. */
  segment: string;
  rank?: string | null;
}

export interface ContextDocument {
  id: string;
  folderId: string | null;
  /** The stem: the filename is `renderFilename(name, extension)`. */
  name: string;
  extension: string;
  /** The path segment: the filename, and a later twin's `~` suffix. A path joins these. */
  segment: string;
  fileType: DocumentFileType | null;
  filetype: Filetype | null;
  storageUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  hasPreview: boolean;
  updatedAt: string;
  /** `documents.metadata` as stored; read through `document-metadata.ts`. */
  metadata: unknown;
  rank?: string | null;
}

/** One node and what is under it, read by id from live or from the Trash entry that holds it. */
export interface ContextSubtree {
  root: { kind: "folder"; folder: ContextFolder } | { kind: "document"; document: ContextDocument };
  /** Every folder under the root (the root excluded), parents named by `parentId`. */
  folders: ContextFolder[];
  /** Every document under the root (the root excluded). */
  documents: ContextDocument[];
}

export interface LocatedContextDocument {
  contextSourceId: string;
  document: ContextDocument;
  path: string;
}

export interface ContextDocumentStore {
  /** Run several per-source operations in one transaction (the source provisioned in it). */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  /** The backing context_sources.id for this scoped tree, provisioned. */
  contextSourceId(): Promise<string>;
  /** Return the backing source when already materialized, without provisioning it. */
  existingContextSourceId(): Promise<string | null>;
  /**
   * What `view` shows at a source-relative path, by the tree reader's one meaning of "same
   * path" (segments, so a twin's `~id` reaches it). A path of the other kind is `not_found`.
   * The source root (`""`) is the folder `null`.
   */
  resolveDocumentAt(view: TreeView, path: string): Promise<PathResolution<ContextDocument>>;
  resolveFolderAt(view: TreeView, path: string): Promise<PathResolution<ContextFolder | null>>;
  /** A document visible in the view, by id, with its path there. */
  findDocumentById(view: TreeView, documentId: string): Promise<LocatedContextDocument | null>;
  /**
   * The node `id` and everything under it, wherever it stands now in this source: live, or in
   * Trash with what its delete took. Null when this source holds no such node (purged, or
   * moved to another source).
   */
  readSubtree(id: string): Promise<ContextSubtree | null>;
  /** Every folder and document the view shows in this source, in one pass. */
  listTree(view: TreeView): Promise<{ folders: ContextFolder[]; documents: ContextDocument[] }>;
  listFolders(view: TreeView, parentId: string | null): Promise<ContextFolder[]>;
  listDocuments(view: TreeView, folderId: string | null): Promise<ContextDocument[]>;
}
