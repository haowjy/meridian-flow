import type { StoredDocumentProperties } from "@meridian/contracts";

/** Reads the frontmatter stored with a document, whose access the caller has already granted. */
export interface DocumentPropertiesReader {
  /** `null` when the document has no stored properties or no longer exists. */
  findStored(documentId: string): Promise<StoredDocumentProperties | null>;
}
