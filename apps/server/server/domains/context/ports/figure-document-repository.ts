import type { BinaryDocumentFileType } from "@meridian/contracts/protocol";

import type { TreeView } from "../tree/tree-view.js";

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
    view?: TreeView,
  ): Promise<DocumentFileRecord | null>;
}
