/** Initialize-only persistence boundary for a document's first canonical state. */

import type { DocumentId } from "@meridian/contracts/runtime";

export interface InitialDocumentSeeds {
  /** Returns true only when this call installed the first journal state. */
  seedInitialDocument(documentId: DocumentId, state: Uint8Array): Promise<boolean>;
}
