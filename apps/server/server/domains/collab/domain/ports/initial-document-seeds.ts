/**
 * Initialize-only persistence boundary for a document's first canonical state: the one
 * writer of a Yjs authority head (the create's transaction, or explicit repair).
 */

import type { DocumentId } from "@meridian/contracts/runtime";

export interface InitialDocumentSeeds {
  /**
   * Under the document's mutation lock, after proving its row is living, installs the head
   * and the seed checkpoint. Returns true only when this call installed the first state;
   * never writes over an existing checkpoint or update. Throws `DocumentNotFoundError` with its
   * removal record for a removed document.
   */
  seedInitialDocument(documentId: DocumentId, state: Uint8Array): Promise<boolean>;
  /**
   * The stored projection (empty when none) of a document with no checkpoint and no update,
   * or null when its authority exists. One read; the repair's fast path.
   */
  missingAuthorityProjection(documentId: DocumentId): Promise<string | null>;
}
