/** Collab-owned read boundary for durable document authority prefixes. */

import type { DocumentAuthorityId, DocumentId } from "@meridian/contracts";

export type DocumentAuthorityHead = {
  documentId: DocumentId;
  authorityId: DocumentAuthorityId;
  generation: bigint;
  admittedThrough: bigint;
};

export interface DocumentAuthorityHeads {
  /** Idempotently initializes missing heads, then returns one head per unique document ID. */
  ensureAndReadAuthorityHeads(
    documentIds: readonly string[],
  ): Promise<readonly DocumentAuthorityHead[]>;
}
