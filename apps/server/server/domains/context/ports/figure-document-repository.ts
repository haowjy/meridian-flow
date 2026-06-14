import type { BinaryDocumentFileType } from "@meridian/contracts/protocol";

export interface DocumentFileRecord {
  documentId: string;
  storageUrl: string;
  mimeType: string;
  fileType: BinaryDocumentFileType;
  sizeBytes: number;
}

export interface AttachDocumentFileInput extends DocumentFileRecord {
  projectId: string;
}

export interface FigureDocumentRepository {
  findDocumentFileForProject(
    projectId: string,
    documentId: string,
  ): Promise<DocumentFileRecord | null>;
  attachDocumentFile(input: AttachDocumentFileInput): Promise<DocumentFileRecord | null>;
}
