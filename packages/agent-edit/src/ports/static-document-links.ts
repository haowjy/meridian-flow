/**
 * In-memory `DocumentLinksPort` over a fixed catalog: agent-edit tests and the
 * server's in-memory composition. It is a real adapter, not a stub; a test
 * moves a document by changing the catalog, never by writing to a holder.
 */
import {
  type CatalogDocument,
  type CatalogFolder,
  matchDocumentPath,
  parseContextUri,
  parseLinkRef,
  splitDocumentHrefSuffix,
} from "@meridian/contracts";
import {
  type AssetAddress,
  createHolderLinkScope,
  type HolderCatalog,
  type HolderLinkScope,
  writtenAddresses,
} from "@meridian/markup/links";
import { storedLinkKeys } from "@meridian/markup/stored-links";
import * as Y from "yjs";
import type { DocumentLinksPort } from "./document-links.js";

export interface StaticCatalogDocument extends CatalogDocument {
  /** An image the shipped `asset:` rule may claim. */
  image?: boolean;
}

export interface StaticDocumentCatalog {
  projectId: string;
  /** Read at every call, so replacing an entry moves, deletes or creates a document. */
  documents: readonly StaticCatalogDocument[];
  /** Read at every call, so replacing an entry moves or removes a folder. */
  folders?: readonly CatalogFolder[];
  /** Ahead id → settled document id. */
  settlements?: ReadonlyMap<string, string>;
}

export interface StaticDocumentLinksOptions {
  /**
   * Answer every lookup as loaded. Only for compositions whose doors never
   * prepare through this port (the server's in-memory scopes); tests keep the
   * default, so a door that forgot to prepare a key sees a real snapshot miss.
   */
  preloaded?: boolean;
}

/**
 * Keys loaded by `prepare`, the way the server's batched loader loads them:
 * documents by id, settlements by ahead id, and documents at addresses.
 * Unlike a server snapshot it lives as long as the port, so it is never finer.
 */
interface Loaded {
  ids: Set<string>;
  folderIds: Set<string>;
  aheadIds: Set<string>;
  addresses: Set<string>;
  folderAddresses: Set<string>;
}

export function createStaticDocumentLinks(
  catalog: StaticDocumentCatalog = { projectId: "static", documents: [] },
  options: StaticDocumentLinksOptions = {},
): DocumentLinksPort & { minted: string[]; misses: string[] } {
  const minted: string[] = [];
  const misses: string[] = [];
  const loaded: Loaded | null = options.preloaded
    ? null
    : {
        ids: new Set(),
        folderIds: new Set(),
        aheadIds: new Set(),
        addresses: new Set(),
        folderAddresses: new Set(),
      };
  const byId = (id: string) => catalog.documents.find((entry) => entry.documentId === id);
  const scopeFor = (documentId: string): HolderLinkScope => {
    const miss = (key: string) => misses.push(key);
    if (loaded && !loaded.ids.has(documentId)) miss(`holder:${documentId}`);
    const holderUri = !loaded || loaded.ids.has(documentId) ? byId(documentId)?.uri : undefined;
    return createHolderLinkScope(
      { uri: holderUri ?? null, projectId: catalog.projectId, view: { kind: "live" } },
      staticHolderCatalog(catalog, loaded),
      miss,
    );
  };
  return {
    minted,
    misses,
    async prepare(request) {
      if (!loaded) return;
      loaded.ids.add(request.documentId);
      const holderUri = byId(request.documentId)?.uri ?? null;
      const keys = storedLinkKeys({
        docs: request.docs,
        ...(request.stored ? { nodes: request.stored } : {}),
        refs: [...(request.shown ?? []).map((showing) => showing.ref), ...(request.refs ?? [])],
        holderUri,
      });
      for (const address of request.addresses ?? []) loaded.addresses.add(address);
      for (const id of keys.assetIds) loaded.ids.add(id);
      for (const address of keys.aheadAddresses) loaded.addresses.add(address);
      for (const address of keys.folderAddresses) loaded.folderAddresses.add(address);
      for (const ref of keys.refs) {
        const parsed = parseLinkRef(ref);
        if (parsed?.kind === "doc") loaded.ids.add(parsed.documentId);
        if (parsed?.kind === "folder") loaded.folderIds.add(parsed.folderId);
        if (parsed?.kind !== "ahead") continue;
        loaded.aheadIds.add(parsed.aheadId);
        const settled = catalog.settlements?.get(parsed.aheadId);
        if (settled) loaded.ids.add(settled);
      }
      // A deleted picture keeps its path only while no other image holds it.
      for (const id of loaded.ids) {
        const entry = byId(id);
        if (entry?.image && entry.presence === "deleted") loaded.addresses.add(entry.uri);
      }
      for (const target of writtenAddresses(
        request.written ?? [],
        holderUri,
        request.context?.uploadsChat,
      )) {
        loaded[target.kind === "folder" ? "folderAddresses" : "addresses"].add(target.uri);
      }
      // A row an address load found is known by id too, as the server remembers it.
      for (const entry of catalog.documents) {
        if ([...loaded.addresses].some((uri) => matchDocumentPath([entry], uri, (doc) => doc.uri)))
          loaded.ids.add(entry.documentId);
      }
      for (const folder of catalog.folders ?? []) {
        if (loaded.folderAddresses.has(folder.uri)) loaded.folderIds.add(folder.folderId);
      }
    },
    scopeFor,
    async registerAhead(mints) {
      for (const mint of mints) minted.push(mint.ref);
    },
    revision: (doc, scope) => staticRevision(doc, scope, catalog),
  };
}

function staticHolderCatalog(catalog: StaticDocumentCatalog, loaded: Loaded | null): HolderCatalog {
  const present = () => catalog.documents.filter((entry) => entry.presence !== "deleted");
  const reachable = (entry: CatalogDocument) => entry.readable && entry.nameable;
  const byId = (id: string) => catalog.documents.find((entry) => entry.documentId === id) ?? null;
  const folderById = (id: string) =>
    catalog.folders?.find((entry) => entry.folderId === id) ?? null;
  // `undefined` is a snapshot miss: the key was never prepared.
  const ifLoaded = <T>(set: keyof Loaded, key: string, answer: () => T): T | undefined =>
    !loaded || loaded[set].has(key) ? answer() : undefined;
  return {
    document: (id) => ifLoaded("ids", id, () => byId(id)),
    folder: (id) => ifLoaded("folderIds", id, () => folderById(id)),
    folderAt: (uri) =>
      ifLoaded(
        "folderAddresses",
        uri,
        () =>
          catalog.folders?.find((entry) => entry.uri === uri && entry.readable && entry.nameable) ??
          null,
      ),
    settlement: (aheadId) =>
      ifLoaded("aheadIds", aheadId, () => catalog.settlements?.get(aheadId) ?? null),
    documentAt: (uri) =>
      ifLoaded("addresses", uri, () => present().find((entry) => entry.uri === uri) ?? null),
    documentFor: (uri) =>
      ifLoaded("addresses", uri, () =>
        matchDocumentPath(present().filter(reachable), uri, (entry) => entry.uri),
      ),
    assetAddress: (id) =>
      ifLoaded("ids", id, (): AssetAddress | null | undefined => {
        const entry = byId(id);
        if (!entry?.image || entry.projectId !== catalog.projectId) return null;
        const parsed = parseContextUri(entry.uri);
        const path = parsed.ok && parsed.value.scheme === "manuscript" ? parsed.value.path : null;
        if (path !== null && entry.presence !== "deleted") return { kind: "path", path };
        if (path !== null) {
          // A deleted picture keeps its path only while no other image holds it.
          if (loaded && !loaded.addresses.has(entry.uri)) return undefined;
          const images = catalog.documents.filter((each) => each.image && each.uri === entry.uri);
          if (images.length === 1) return { kind: "path", path };
        }
        return { kind: "last", uri: entry.uri };
      }),
    assetFor: (uri) =>
      ifLoaded(
        "addresses",
        splitDocumentHrefSuffix(uri).path,
        () =>
          present().find((entry) => entry.image && entry.uri === splitDocumentHrefSuffix(uri).path)
            ?.documentId ?? null,
      ),
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
        catalog.folders?.map((entry) => [
          entry.folderId,
          entry.uri,
          entry.readable,
          entry.nameable,
        ]),
        [...(catalog.settlements ?? [])],
      ]),
    ),
  );
  return `static:${hash.toString(16)}`;
}
