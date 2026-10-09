/** Durable cuts and atomic certification for live-document derived outputs. */
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";

import type { DocumentLinkRow } from "../document-link-rows.js";

// Changing the extractor must bump this version to invalidate older output.
export const DOCUMENT_EXTRACTOR_VERSION = 3;
export type DerivationScope = { projectId: ProjectId; personalOwnerId?: UserId };
export type DerivationWatermark = {
  generation: bigint;
  admissionSequence: bigint;
  locationVersion: bigint;
  extractorVersion: number;
};
export type DocumentDerivationCut = {
  documentId: DocumentId;
  watermark: DerivationWatermark;
  state: Uint8Array;
  holderUri: string | null;
  holderProjectId: ProjectId;
  kind: "content" | "manifest";
};
export type DocumentDerivationStore = {
  capture(documentId: DocumentId): Promise<DocumentDerivationCut | null>;
  certify(
    cut: DocumentDerivationCut,
    outputs: { markdown: string; links: DocumentLinkRow[] },
    at: Date,
  ): Promise<boolean>;
  stale(
    scope?: DerivationScope,
    page?: { after?: DocumentId; limit: number },
  ): Promise<DocumentId[]>;
  /**
   * Registers the client-minted ahead refs of this holder's certified rows (contract §11.3):
   * awaited outside a transaction, after commit inside one. Failures are logged, never thrown;
   * `recoverAheads` picks them up.
   */
  registerAheads(documentId: DocumentId): Promise<void>;
  /** Recovery: index refs with no registry row, in scope (everywhere when absent). Never throws. */
  recoverAheads(scope?: DerivationScope): Promise<number>;
};
export type DocumentDerivationResult =
  | { status: "derived"; stateVector: Uint8Array }
  | { status: "missing" }
  | { status: "deferred" };

export type DocumentDerivationService = {
  derive(documentId: DocumentId, at?: Date): Promise<DocumentDerivationResult>;
  schedule(documentId: DocumentId): void;
  sweep(): Promise<number>;
  flush(scope: DerivationScope): Promise<void>;
  stop(): Promise<void>;
};
