/** Initialize-only persistence boundary for a document's first canonical state. */
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
  /** Returns true only when this call installed the first journal state. */
  seedInitialDocument(documentId: DocumentId, state: Uint8Array): Promise<boolean>;
}
