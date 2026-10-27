/**
 * Initialize-only persistence boundary for a document's first canonical state: the one
 * writer of a Yjs authority head (the create's transaction, or explicit repair).
 */

import type { DocumentId } from "@meridian/contracts/runtime";

/** Encoded outside transactions; staging and reveal never decode a Y.Doc. */
export interface PreparedSeed {
  documentId: DocumentId;
  state: Uint8Array;
  stateVector: Uint8Array;
  attributionManifest: unknown;
  markdown: string;
}

export type SeedAnnouncement = Pick<PreparedSeed, "documentId" | "markdown">;

export interface InitialDocumentSeeds {
  /** Caller holds the staging owner's lock and checks its generation. No live rows. */
  stageInitialStates(
    stagingId: string,
    projectId: string,
    generation: number,
    seeds: readonly PreparedSeed[],
  ): Promise<void>;
  /** Caller has just inserted the documents in this transaction. Existing heads are an error. */
  commitStagedStates(stagingId: string): Promise<SeedAnnouncement[]>;
  discardStagedStates(stagingId: string, limit?: number): Promise<{ remaining: boolean }>;
  /**
   * Under the document's mutation lock, after proving its row is living, installs the head
   * and the seed checkpoint. Returns true only when this call installed the first state;
   * never writes over an existing checkpoint or update. Throws `DocumentNotFoundError` with its
   * removal record for a removed document.
   */
  seedInitialDocument(documentId: DocumentId, state: Uint8Array): Promise<boolean>;
  /**
   * The first state of documents the caller's transaction just created, installed in a fixed
   * number of statements: a bulk create's seeds. Takes no lock and proves no liveness, so it
   * takes only documents nothing else can yet reach, and refuses (a unique key) one that
   * already has a head or a seed checkpoint.
   */
  seedInitialDocuments(
    seeds: readonly { documentId: DocumentId; state: Uint8Array }[],
  ): Promise<void>;
  /**
   * The stored projection (empty when none) of a document with no checkpoint and no update,
   * or null when its authority exists. One read; the repair's fast path.
   */
  missingAuthorityProjection(documentId: DocumentId): Promise<string | null>;
}
