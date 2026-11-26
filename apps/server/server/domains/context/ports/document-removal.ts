import type { DocumentId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";

export interface DocumentRemovals {
  lookup(
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, DocumentRemovalRecord>>;
  actors(
    authors: Iterable<string | null>,
  ): Promise<(by: string | null) => DocumentRemovalRecord["actor"]>;
}
