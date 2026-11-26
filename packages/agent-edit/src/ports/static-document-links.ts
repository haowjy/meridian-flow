import {
  type CatalogDocument,
  type CatalogFolder,
  matchOmittedExtension,
  parseContextUri,
  parseLinkRef,
  splitDocumentHrefSuffix,
} from "@meridian/contracts";
import {
  addressCandidates,
  childAtSegment,
  readSegment,
  type Walkable,
} from "@meridian/contracts/protocol";
import {
  type AssetAddress,
  createHolderLinkScope,
  type HolderCatalog,
  type HolderLinkScope,
  writtenAddresses,
} from "@meridian/markup/links";
import { storedLinkKeys } from "@meridian/markup/stored-links";
import type { DocumentLinksPort } from "./document-links.js";

export interface StaticCatalogDocument extends CatalogDocument {
  image?: boolean;
}

export interface StaticDocumentCatalog {
  projectId: string;
  documents: readonly StaticCatalogDocument[];
  folders?: readonly CatalogFolder[];
  settlements?: ReadonlyMap<string, string>;
}

export interface StaticDocumentLinksOptions {
  preloaded?: boolean;
}

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
      const tree = catalogTree(catalog.documents, catalog.folders);
      for (const uri of loaded.addresses) {
        const found = tree.documentAt(uri);
        if (found) loaded.ids.add(found.documentId);
      }
      for (const uri of loaded.folderAddresses) {
        const found = tree.folderAt(uri);
        if (found) loaded.folderIds.add(found.folderId);
      }
    },
    scopeFor,
    async registerAhead(mints) {
      for (const mint of mints) minted.push(mint.ref);
    },
    revision: (cut, scope) => cutRevision(cut.version, scope, catalog),
  };
}

function staticHolderCatalog(catalog: StaticDocumentCatalog, loaded: Loaded | null): HolderCatalog {
  const present = () => catalog.documents.filter((entry) => entry.presence !== "deleted");
  const reachable = (entry: CatalogDocument) => entry.readable && entry.nameable;
  const byId = (id: string) => catalog.documents.find((entry) => entry.documentId === id) ?? null;
  const folderById = (id: string) =>
    catalog.folders?.find((entry) => entry.folderId === id) ?? null;
  const ifLoaded = <T>(set: keyof Loaded, key: string, answer: () => T): T | undefined =>
    !loaded || loaded[set].has(key) ? answer() : undefined;
  return {
    document: (id) => ifLoaded("ids", id, () => byId(id)),
    folder: (id) => ifLoaded("folderIds", id, () => folderById(id)),
    folderAt: (uri) =>
      ifLoaded("folderAddresses", uri, () => {
        const folder = catalogTree(catalog.documents, catalog.folders).folderAt(uri);
        return folder?.readable && folder.nameable ? folder : null;
      }),
    settlement: (aheadId) =>
      ifLoaded("aheadIds", aheadId, () => catalog.settlements?.get(aheadId) ?? null),
    documentAt: (uri) =>
      ifLoaded("addresses", uri, () => catalogTree(present(), catalog.folders).documentAt(uri)),
    documentFor: (uri) =>
      ifLoaded("addresses", uri, () =>
        catalogTree(present().filter(reachable), catalog.folders).documentAt(uri),
      ),
    assetAddress: (id) =>
      ifLoaded("ids", id, (): AssetAddress | null | undefined => {
        const entry = byId(id);
        if (!entry?.image || entry.projectId !== catalog.projectId) return null;
        const parsed = parseContextUri(entry.uri);
        const path = parsed.ok && parsed.value.scheme === "manuscript" ? parsed.value.path : null;
        if (path !== null && entry.presence !== "deleted") return { kind: "path", path };
        if (path !== null) {
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

type CatalogNode = Walkable & {
  children: CatalogNode[];
  document?: StaticCatalogDocument;
  folder?: CatalogFolder;
};

function catalogTree(
  documents: readonly StaticCatalogDocument[],
  folders: readonly CatalogFolder[] = [],
) {
  const dirs = new Map<string, CatalogNode>();
  const sourceOf = (parsed: Extract<ReturnType<typeof parseContextUri>, { ok: true }>) =>
    JSON.stringify([parsed.value.scheme, parsed.value.authority]);
  const dirAt = (source: string, path: string, listed?: CatalogFolder): CatalogNode => {
    const key = `${source}\0${path}`;
    let node = dirs.get(key);
    if (!node) {
      const slash = path.lastIndexOf("/");
      const { name, suffix } = readSegment(path.slice(slash + 1));
      node = { id: suffix ?? key, kind: "folder", name, suffix, trashed: false, children: [] };
      if (path !== "") dirAt(source, path.slice(0, Math.max(slash, 0))).children.push(node);
      dirs.set(key, node);
    }
    if (listed) Object.assign(node, { id: listed.folderId, folder: listed });
    return node;
  };
  const leafOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));
  for (const listed of folders) {
    const parsed = parseContextUri(listed.uri);
    if (parsed.ok) dirAt(sourceOf(parsed), parsed.value.path, listed);
  }
  for (const document of documents) {
    const parsed = parseContextUri(document.uri);
    if (!parsed.ok) continue;
    const { name, suffix } = readSegment(leafOf(parsed.value.path));
    dirAt(sourceOf(parsed), dirOf(parsed.value.path)).children.push({
      id: document.documentId,
      kind: "document",
      name,
      suffix,
      trashed: false,
      children: [],
      document,
    });
  }
  const walk = (source: string, segments: readonly string[]): CatalogNode | undefined => {
    let at = dirs.get(`${source}\0`);
    for (const segment of segments) {
      at = at && childAtSegment(at.children, segment, "folder");
    }
    return at;
  };
  return {
    documentAt(uri: string): StaticCatalogDocument | null {
      const parsed = parseContextUri(uri);
      if (!parsed.ok) return null;
      const segments = parsed.value.path.split("/");
      const leaf = segments.pop() as string;
      const folder = walk(sourceOf(parsed), segments);
      if (!folder) return null;
      for (const candidate of addressCandidates(leaf)) {
        const found = childAtSegment(folder.children, candidate);
        if (found?.document) return found.document;
      }
      return (
        matchOmittedExtension(
          folder.children.filter((node) => node.document),
          leaf,
          (node) => (node.suffix === undefined ? node.name : `${node.name}~${node.suffix}`),
        )?.document ?? null
      );
    },
    folderAt(uri: string): CatalogFolder | null {
      const parsed = parseContextUri(uri);
      return (parsed.ok && walk(sourceOf(parsed), parsed.value.path.split("/"))?.folder) || null;
    },
  };
}

function cutRevision(state: Uint8Array, scope: HolderLinkScope, catalog: StaticDocumentCatalog) {
  let hash = 0x811c9dc5;
  const feed = (bytes: Uint8Array) => {
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  };
  feed(state);
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
