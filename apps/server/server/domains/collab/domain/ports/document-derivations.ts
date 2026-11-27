import type { LoroDocument } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";

import type { DocumentLinkRow } from "../document-link-rows.js";

// Changing the extractor must bump this version to invalidate older output.
export const DOCUMENT_EXTRACTOR_VERSION = 8;
export type DerivationWatermark = {
  contentSeq: bigint;
  locationVersion: bigint;
  extractorVersion: number;
};
export type DocumentDerivationCut = {
  documentId: DocumentId;
  watermark: DerivationWatermark;
  /** A copy of the Live room as the cut read it; whoever captured the cut frees it. */
  doc: LoroDocument;
  holderUri: string | null;
};
export type DerivedBlock = {
  id: string;
  text: string;
  contentHash: Buffer;
};
export type DocumentDerivationOutputs = {
  blocks: DerivedBlock[];
  wordCount: number;
  documentBytes: number;
  documentHash: Buffer;
  links: DocumentLinkRow[];
};
export type DocumentDerivationStore = {
  capture(documentId: DocumentId): Promise<DocumentDerivationCut | null>;
  certify(
    cut: DocumentDerivationCut,
    outputs: DocumentDerivationOutputs,
    at: Date,
  ): Promise<boolean>;
  stale(page?: { after?: DocumentId; limit: number; only?: DocumentId }): Promise<DocumentId[]>;
  /**
   * Registers the client-minted ahead refs of this holder's certified rows (contract §11.3):
   * awaited outside a transaction, after commit inside one. Failures are logged, never thrown;
   * the sweep picks them up.
   */
  registerAheads(documentId: DocumentId): Promise<void>;
  recoverAheads(after?: string): Promise<{ registered: number; next: string | null }>;
};
export type DocumentDerivationResult =
  | { status: "derived"; version: Uint8Array }
  | { status: "missing" }
  | { status: "deferred" };

export type DocumentDerivationService = {
  derive(documentId: DocumentId, at?: Date): Promise<DocumentDerivationResult>;
  schedule(documentId: DocumentId): void;
  sweep(): Promise<number>;
  stop(): Promise<void>;
};
