import type { ContextSourceId, DocumentId } from "@meridian/contracts/runtime";

export interface DocumentArrivals {
  lockNamespaces(
    documentIds: readonly DocumentId[],
    sourceIds?: readonly ContextSourceId[],
  ): Promise<void>;
  settle(documentIds: readonly DocumentId[]): Promise<number>;
}
