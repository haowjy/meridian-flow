import type { DocumentLinkScope } from "@meridian/markup";
import type { HolderLinkScope } from "@meridian/markup/links";

export interface ExportDocumentReader {
  readForExport(
    documentId: string,
    scope: (links: HolderLinkScope) => DocumentLinkScope,
  ): Promise<{ ok: true; value: string } | { ok: false }>;
}
