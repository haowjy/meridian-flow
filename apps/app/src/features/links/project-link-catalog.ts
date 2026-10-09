/**
 * The client's `HolderCatalog`: the shared link rules (`resolveStoredLink`)
 * read the scope's local document index through it, and the account's
 * settlement memo answers `settlement()`.
 *
 * Every lookup the index cannot answer for certain is `undefined`, "not held,
 * ask the server": a `doc:` ref the complete index does not hold may name
 * another Work's Scratch or a document the reader lost, and an incomplete
 * index cannot prove what is at an address. Nothing is ever answered `null`
 * for a document, so on the client a local `gone` is only a malformed ref.
 */

import type { CatalogDocument } from "@meridian/contracts";
import type { HolderCatalog } from "@meridian/markup/links";

import { indexedDocumentAt } from "@/core/editor/links";

import type { ProjectLinkSettlements } from "./link-settlements";
import type { LinkableDocument, LinkableDocumentIndex } from "./useLinkableDocuments";

/** The catalog, and the index row behind each document it answers with. */
export type ProjectLinkCatalog = HolderCatalog & {
  indexed(documentId: string): LinkableDocument | undefined;
};

export function createProjectLinkCatalog(
  projectId: string,
  index: LinkableDocumentIndex,
  settlements: ProjectLinkSettlements,
): ProjectLinkCatalog {
  const byId = new Map(index.documents.map((document) => [document.documentId, document]));
  const catalogDocument = (document: LinkableDocument): CatalogDocument => ({
    documentId: document.documentId,
    projectId,
    uri: document.uri,
    presence: "live",
    readable: true,
    nameable: true,
  });
  const held = (document: LinkableDocument | null | undefined) =>
    document ? catalogDocument(document) : undefined;
  return {
    indexed: (documentId) => byId.get(documentId),
    document: (documentId) => (index.complete ? held(byId.get(documentId)) : undefined),
    settlement(aheadId) {
      const settled = settlements.get(aheadId);
      // Settled on an unknown document: never its address, so ask.
      if (settled === null) return undefined;
      // Not known settled: rule 4 shows what is at its address while the server is asked.
      return settled ?? null;
    },
    documentAt(uri) {
      if (!index.complete) return undefined;
      const document = index.documents.find((candidate) => candidate.uri === uri);
      return document ? catalogDocument(document) : null;
    },
    documentFor(uri) {
      if (!index.complete) return undefined;
      return held(indexedDocumentAt(index.documents, uri)) ?? null;
    },
    assetAddress: () => undefined,
    assetFor: () => undefined,
  };
}
