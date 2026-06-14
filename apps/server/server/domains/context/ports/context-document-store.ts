/**
 * Primitive folder/document storage for one ContextFS context source.
 *
 * The store deals in single tree nodes — the path-resolution and
 * folder-auto-creation logic lives in {@link ContextFS}, which is
 * tested once against the in-memory store. Concrete stores (Drizzle,
 * in-memory) are thin and obviously correct.
 *
 * `parentId`/`folderId` of `null` denotes the source root.
 */
import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
export interface ContextFolder {
  id: string;
  parentId: string | null;
  name: string;
}

export interface ContextDocument {
  id: string;
  folderId: string | null;
  name: string;
  extension: string;
  markdown: string;
  fileType: DocumentFileType | null;
  filetype: Filetype | null;
  storageUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  updatedAt: string;
}

export interface ContextSearchRow {
  document: ContextDocument;
  /** Slash-joined folder names from the source root to the document's folder. */
  folderPath: string;
  excerpt: string;
  line?: number;
}

export interface UpsertDocumentInput {
  folderId: string | null;
  name: string;
  extension: string;
  markdown: string;
  filetype: Filetype;
}

/** Input for creating a binary (storage-backed) document in the context tree. */
export interface CreateBinaryDocumentInput {
  folderId: string | null;
  name: string;
  extension: string;
  fileType: DocumentFileType;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ContextDocumentStore {
  findFolder(parentId: string | null, name: string): Promise<ContextFolder | null>;
  createFolder(parentId: string | null, name: string): Promise<ContextFolder>;
  findDocument(
    folderId: string | null,
    name: string,
    extension: string,
  ): Promise<ContextDocument | null>;
  upsertDocument(input: UpsertDocumentInput): Promise<ContextDocument>;
  /** Create a binary (non-editable) document backed by object storage. */
  createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument>;
  listFolders(parentId: string | null): Promise<ContextFolder[]>;
  listDocuments(folderId: string | null): Promise<ContextDocument[]>;
  searchDocuments(query: string): Promise<ContextSearchRow[]>;
}
