/** Internal storage for thread upload backing documents. */
import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";

export interface InternalUploadDocumentCreateInput {
  id: string;
  workbenchId: string;
  threadId: string;
  filename: string;
  name: string;
  extension: string;
  filetype: Filetype | null;
  mimeType: string;
  sizeBytes: number;
  markdownProjection: string;
  storageUrl: string | null;
}

export interface InternalUploadDocumentRecord {
  id: string;
  name: string;
  extension: string;
  filetype: Filetype | null;
  fileType: DocumentFileType | null;
  mimeType: string | null;
  sizeBytes: number | null;
  storageUrl: string | null;
  markdownProjection: string;
  updatedAt: string;
}

export interface InternalUploadDocumentStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  createThreadUploadDocument(
    input: InternalUploadDocumentCreateInput,
  ): Promise<InternalUploadDocumentRecord>;
  updateMarkdownProjection(documentId: string, markdown: string): Promise<void>;
  findUploadDocument(documentId: string): Promise<InternalUploadDocumentRecord | null>;
  findUploadDocuments(documentIds: string[]): Promise<InternalUploadDocumentRecord[]>;
}
