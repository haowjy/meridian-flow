import type { StoredDocumentProperties } from "@meridian/contracts";

export interface DocumentPropertiesReader {
  findStored(documentId: string): Promise<StoredDocumentProperties | null>;
}
