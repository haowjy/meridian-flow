/** Durable cuts and atomic certification for live-document derived outputs. */
import type { DocumentId } from "@meridian/contracts/runtime";

import type { DocumentLinkRow } from "../document-link-rows.js";

// Changing the extractor must bump this version to invalidate older output.
export const DOCUMENT_EXTRACTOR_VERSION = 5;
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
};
/** One top-level block of the cut, in the shape the store keeps it. */
export type DerivedBlock = {
  /** "<clientID>:<clock>" of the block's own Yjs item. */
  id: string;
  /** What `grep` matches (`grepBlockText`). */
  text: string;
  /** Hash of the destination-free markdown: the key the store diffs on. */
  contentHash: Buffer;
};
export type DocumentDerivationOutputs = {
  /** In document order. */
  blocks: DerivedBlock[];
  wordCount: number;
  /** Sum of the blocks' text bytes. */
  documentBytes: number;
  /** Ordered block content hashes plus the link facts: the edit signal behind `updated_at`. */
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
  /** Documents whose certified outputs trail their cut; `only` asks about one document. */
  stale(page?: { after?: DocumentId; limit: number; only?: DocumentId }): Promise<DocumentId[]>;
  /**
   * Registers the client-minted ahead refs of this holder's certified rows (contract §11.3):
   * awaited outside a transaction, after commit inside one. Failures are logged, never thrown;
   * the sweep picks them up.
   */
  registerAheads(documentId: DocumentId): Promise<void>;
  /**
   * One bounded recovery page everywhere, strictly after `after`. `next` is the last ref attempted
   * on a full page (resume there), else null (wrap). Never throws.
   */
  recoverAheads(after?: string): Promise<{ registered: number; next: string | null }>;
};
export type DocumentDerivationResult =
  | { status: "derived"; stateVector: Uint8Array }
  | { status: "missing" }
  | { status: "deferred" };

export type DocumentDerivationService = {
  derive(documentId: DocumentId, at?: Date): Promise<DocumentDerivationResult>;
  schedule(documentId: DocumentId): void;
  sweep(): Promise<number>;
  stop(): Promise<void>;
};
