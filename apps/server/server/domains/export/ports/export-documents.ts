/** Export's view of document content through the canonical live tree. */
import type { DocumentLinkScope } from "@meridian/markup";
import type { HolderLinkScope } from "@meridian/markup/links";

export interface ExportDocumentReader {
  /** Serializes with the export codec, spelling links through the scope Export supplies. */
  readForExport(
    documentId: string,
    scope: (links: HolderLinkScope) => DocumentLinkScope,
  ): Promise<{ ok: true; value: string } | { ok: false }>;
}
