import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
import type { PathResolution, TreeView } from "../tree/tree-view.js";

export interface ContextFolder {
  id: string;
  parentId: string | null;
  name: string;
  segment: string;
  rank?: string | null;
}

export interface ContextDocument {
  id: string;
  folderId: string | null;
  name: string;
  extension: string;
  segment: string;
  fileType: DocumentFileType | null;
  filetype: Filetype | null;
  storageUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  hasPreview: boolean;
  updatedAt: string;
  metadata: unknown;
  rank?: string | null;
}

export interface ContextSubtree {
  root: { kind: "folder"; folder: ContextFolder } | { kind: "document"; document: ContextDocument };
  folders: ContextFolder[];
  documents: ContextDocument[];
}

export interface LocatedContextDocument {
  contextSourceId: string;
  document: ContextDocument;
  path: string;
}

export interface ContextDocumentStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  contextSourceId(): Promise<string>;
  existingContextSourceId(): Promise<string | null>;
  /**
   * What `view` shows at a source-relative path, by the tree reader's one meaning of "same
   * path" (segments, so a twin's `~id` reaches it). A path of the other kind is `not_found`.
   * The source root (`""`) is the folder `null`.
   */
  resolveDocumentAt(view: TreeView, path: string): Promise<PathResolution<ContextDocument>>;
  resolveFolderAt(view: TreeView, path: string): Promise<PathResolution<ContextFolder | null>>;
  findDocumentById(view: TreeView, documentId: string): Promise<LocatedContextDocument | null>;
  /**
   * The node `id` and everything under it, wherever it stands now in this source: live, or in
   * Trash with what its delete took. Null when this source holds no such node (purged, or
   * moved to another source).
   */
  readSubtree(id: string): Promise<ContextSubtree | null>;
  listTree(view: TreeView): Promise<{ folders: ContextFolder[]; documents: ContextDocument[] }>;
  listFolders(view: TreeView, parentId: string | null): Promise<ContextFolder[]>;
  listDocuments(view: TreeView, folderId: string | null): Promise<ContextDocument[]>;
}
