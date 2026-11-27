import type { DocumentId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";

/** Current removal records, in the caller's transaction. Callers authorize identities before exposing them. */
export interface DocumentRemovals {
  lookup(
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, DocumentRemovalRecord>>;
  actors(
    authors: Iterable<string | null>,
  ): Promise<(by: string | null) => DocumentRemovalRecord["actor"]>;
}
