import type { BinaryDocumentFileType } from "@meridian/contracts/protocol";

export interface DocumentFileRecord {
  assetDocumentId: string;
  storageUrl: string;
  mimeType: string;
  fileType: BinaryDocumentFileType;
  sizeBytes: number;
}

export interface ProjectDocumentFileRecord extends DocumentFileRecord {
  projectId: string;
}

export interface FigureDocumentRepository {
  documentExistsForProject(projectId: string, documentId: string): Promise<boolean>;
  findDocumentFileForProject(
    projectId: string,
    assetDocumentId: string,
  ): Promise<DocumentFileRecord | null>;
}
