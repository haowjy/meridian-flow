/**
 * In-memory `DocumentLinksPort` over a fixed catalog: agent-edit tests and the
 * server's in-memory composition. It is a real adapter, not a stub; a test
 * moves a document by changing the catalog, never by writing to a holder.
 */
import {
  type CatalogDocument,
  matchDocumentPath,
  parseContextUri,
  splitDocumentHrefSuffix,
} from "@meridian/contracts";
import * as Y from "yjs";
import {
  createHolderLinkScope,
  type DocumentLinksPort,
  type HolderCatalog,
  type HolderLinkScope,
} from "./document-links.js";

export interface StaticCatalogDocument extends CatalogDocument {
  /** An image the shipped `asset:` rule may claim. */
  image?: boolean;
}

export interface StaticDocumentCatalog {
  projectId: string;
  /** Read at every call, so replacing an entry moves, deletes or creates a document. */
  documents: readonly StaticCatalogDocument[];
  /** Ahead id → settled document id. */
  settlements?: ReadonlyMap<string, string>;
}

export function createStaticDocumentLinks(
  catalog: StaticDocumentCatalog = { projectId: "static", documents: [] },
): DocumentLinksPort & { minted: string[] } {
  const minted: string[] = [];
  const scopeFor = (documentId: string): HolderLinkScope => {
    const holderDocument = catalog.documents.find((entry) => entry.documentId === documentId);
    return createHolderLinkScope(
      { uri: holderDocument?.uri ?? null, projectId: catalog.projectId, view: { kind: "live" } },
      staticHolderCatalog(catalog),
    );
  };
  return {
    minted,
    prepare: async () => {},
    scopeFor,
    async registerAhead(mints) {
      for (const mint of mints) minted.push(mint.ref);
    },
    revision: (doc, scope) => staticRevision(doc, scope, catalog),
  };
}

function staticHolderCatalog(catalog: StaticDocumentCatalog): HolderCatalog {
  const present = () => catalog.documents.filter((entry) => entry.presence !== "deleted");
  const reachable = (entry: CatalogDocument) => entry.readable && entry.nameable;
  const byId = (id: string) => catalog.documents.find((entry) => entry.documentId === id) ?? null;
  return {
    document: byId,
    settlement: (aheadId) => catalog.settlements?.get(aheadId) ?? null,
    documentAt: (uri) => present().find((entry) => entry.uri === uri) ?? null,
    documentFor: (uri) => matchDocumentPath(present().filter(reachable), uri, (entry) => entry.uri),
    assetPath(id) {
      const entry = byId(id);
      if (!entry?.image || entry.presence === "deleted") return null;
      const parsed = parseContextUri(entry.uri);
      return parsed.ok && parsed.value.scheme === "manuscript" ? parsed.value.path : null;
    },
    assetFor: (uri) =>
      present().find((entry) => entry.image && entry.uri === splitDocumentHrefSuffix(uri).path)
        ?.documentId ?? null,
  };
}

/**
 * Snapshot, holder and the whole catalog: coarser than the server's digest
 * (any catalog change counts), never finer, so a move always changes it.
 * FNV-1a, because this package also runs in the browser.
 */
function staticRevision(doc: Y.Doc, scope: HolderLinkScope, catalog: StaticDocumentCatalog) {
  let hash = 0x811c9dc5;
  const feed = (bytes: Uint8Array) => {
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  };
  feed(Y.encodeSnapshot(Y.snapshot(doc)));
  feed(
    new TextEncoder().encode(
      JSON.stringify([
        scope.holder.uri,
        catalog.documents.map((entry) => [entry.documentId, entry.uri, entry.presence]),
        [...(catalog.settlements ?? [])],
      ]),
    ),
  );
  return `static:${hash.toString(16)}`;
}
