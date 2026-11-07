import { readStoredDocumentProperties } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import type { DocumentPropertiesReader } from "../ports/document-properties-reader.js";
import { createTreeReader, LIVE_TREE } from "../tree/tree-view.js";

export function createDrizzleDocumentPropertiesReader(db: Database): DocumentPropertiesReader {
  return {
    async findStored(documentId) {
      const found = await createTreeReader(db).findById(LIVE_TREE, documentId as DocumentId);
      return found.kind === "found" ? readStoredDocumentProperties(found.document.metadata) : null;
    },
  };
}
