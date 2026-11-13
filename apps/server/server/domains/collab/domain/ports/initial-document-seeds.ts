/**
 * Initialize-only persistence boundary for a document's first canonical state: the one
 * writer of a Yjs authority head (the create's transaction, or explicit repair).
 */

import type { DocumentId } from "@meridian/contracts/runtime";

export interface InitialDocumentSeeds {
  /**
   * Deletes the journals of documents that never got a `documents` row (an import that was
   * stopped or abandoned wrote their first states ahead of their creates). A document that has
   * a row is left alone: its row's delete takes its journal.
   */
  discardUnbornDocuments(documentIds: readonly DocumentId[]): Promise<void>;
  /**
   * Under the document's mutation lock, after proving its row is living, installs the head
   * and the seed checkpoint. Returns true only when this call installed the first state;
   * never writes over an existing checkpoint or update. Throws `DocumentNotFoundError` with its
   * removal record for a removed document.
   */
  seedInitialDocument(documentId: DocumentId, state: Uint8Array): Promise<boolean>;
  /**
   * The first state of documents the caller's transaction just created, or will create (an
   * import writes text before the creates that name it), installed in a fixed number of
   * statements: a bulk create's seeds. Takes no lock and proves no liveness, so it
   * takes only documents nothing else can yet reach, and refuses (a unique key) one that
   * already has a head or a seed checkpoint.
   */
  seedInitialDocuments(
    seeds: readonly { documentId: DocumentId; state: Uint8Array }[],
  ): Promise<void>;
  /** True for a document with no checkpoint and no update. One read; the repair's fast path. */
  lacksAuthority(documentId: DocumentId): Promise<boolean>;
}
