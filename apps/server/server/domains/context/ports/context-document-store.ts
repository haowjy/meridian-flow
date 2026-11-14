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
  rank?: string | null;
}

export interface ContextDocument {
  id: string;
  folderId: string | null;
  name: string;
  extension: string;
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
   * path": two nodes there answer `ambiguous`, never a pick. A path of the other kind is
   * `not_found`. The source root (`""`) is the folder `null`.
   */
  resolveDocumentAt(view: TreeView, path: string): Promise<PathResolution<ContextDocument>>;
  resolveFolderAt(view: TreeView, path: string): Promise<PathResolution<ContextFolder | null>>;
  /** A document visible in the view, by id, with its path there. */
  findDocumentById(view: TreeView, documentId: string): Promise<LocatedContextDocument | null>;
  /** Every folder and document the view shows in this source, in one pass. */
  listTree(view: TreeView): Promise<{ folders: ContextFolder[]; documents: ContextDocument[] }>;
  /** The rendered filenames of every folder and document directly under `parentId`. */
  namesAt(view: TreeView, parentId: string | null): Promise<Set<string>>;
  listFolders(view: TreeView, parentId: string | null): Promise<ContextFolder[]>;
  listDocuments(view: TreeView, folderId: string | null): Promise<ContextDocument[]>;
}
