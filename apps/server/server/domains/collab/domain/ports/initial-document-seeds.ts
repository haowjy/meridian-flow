/** Initialize-only persistence boundary for a document's first canonical state. */

import type { DocumentId } from "@meridian/contracts/runtime";

/** A document's first canonical state, encoded outside any transaction (`prepareSeed`). */
export interface PreparedSeed {
  documentId: DocumentId;
  state: Uint8Array;
  /** Canonical Markdown projection of `state`, for the after-write hook. */
  markdown: string;
}

export interface InitialDocumentSeeds {
  /**
   * Set-wise heads and sequence-0 checkpoints for documents created in the
   * caller's transaction, with `seedInitialDocument`'s invariants. Throws when
   * any named document already has journal state: unlike the singleton, a
   * batch is for documents nobody could have loaded before commit.
   */
  insertInitialStates(seeds: readonly PreparedSeed[]): Promise<void>;
  /** Returns true only when this call installed the first journal state. */
  seedInitialDocument(documentId: DocumentId, state: Uint8Array): Promise<boolean>;
}
