/** Export's view of document content: a scoped read and live manifest membership. */
import type { DocumentLinkScope } from "@meridian/markup";
import type { HolderLinkScope } from "@meridian/markup/links";

export interface ExportDocumentReader {
  /** Serializes with the export codec, spelling links through the scope Export supplies. */
  readForExport(
    documentId: string,
    scope: (links: HolderLinkScope) => DocumentLinkScope,
  ): Promise<{ ok: true; value: string } | { ok: false }>;
  resolveManifestMembership(input: { projectId: string }): Promise<{ members: readonly string[] }>;
}
