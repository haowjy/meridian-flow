/**
 * The record reader domain code depends on. A removed document (in Trash, or purged) refuses as
 * agent-edit's `DocumentNotFoundError` carrying its record (`removal`); every model path words it
 * from that record.
 */

import type { DocumentId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";

/** Current removal records, in the caller's transaction. Callers authorize identities before exposing them. */
export interface DocumentRemovals {
  lookup(
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, DocumentRemovalRecord>>;
}
