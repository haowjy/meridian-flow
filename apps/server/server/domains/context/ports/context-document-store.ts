/**
 * Primitive folder/document storage for one ContextFS context source.
 *
 * The store deals in single tree nodes — path-resolution and
 * folder-auto-creation for normal writes live in ContextFS. Tree moves/deletes
 * go through ContextTreeMutationStore so location CAS and cross-source re-homing
 * have one atomic owner.
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
  /** Optional caller-chosen document id for imports that need stable keys before insert. */
  id?: string;
  folderId: string | null;
  name: string;
  extension: string;
  markdown: string;
  filetype: Filetype;
}

/** Input for creating a binary (storage-backed) document in the context tree. */
export interface CreateBinaryDocumentInput {
  id?: string;
  folderId: string | null;
  name: string;
  extension: string;
  fileType: DocumentFileType;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
}

/** Input for creating or overwriting a binary document at the same path. */
export type UpsertBinaryDocumentInput = CreateBinaryDocumentInput;

export interface ContextDocumentStore {
  /** Run several per-source CRUD operations atomically when the adapter supports it. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  /** The backing context_sources.id for this scoped tree. */
  contextSourceId(): Promise<string>;
  findFolder(parentId: string | null, name: string): Promise<ContextFolder | null>;
  createFolder(parentId: string | null, name: string): Promise<ContextFolder>;
  findDocument(
    folderId: string | null,
    name: string,
    extension: string,
  ): Promise<ContextDocument | null>;
  upsertDocument(input: UpsertDocumentInput): Promise<ContextDocument>;
  createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument>;
  upsertBinaryDocument(input: UpsertBinaryDocumentInput): Promise<ContextDocument>;
  listFolders(parentId: string | null): Promise<ContextFolder[]>;
  listDocuments(folderId: string | null): Promise<ContextDocument[]>;
  searchDocuments(query: string): Promise<ContextSearchRow[]>;
}
