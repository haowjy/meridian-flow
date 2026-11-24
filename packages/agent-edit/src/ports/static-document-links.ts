/**
 * In-memory `DocumentLinksPort` over a fixed catalog of documents: hand-run probes and the server's
 * in-memory composition. Every lookup answers from the catalog, so `prepare` loads nothing; a test
 * moves a document by changing the catalog, never by writing to a holder.
 */
import { type CatalogDocument, matchOmittedExtension, parseContextUri } from "@meridian/contracts";
import {
  addressCandidates,
  childAtSegment,
  readSegment,
  type Walkable,
} from "@meridian/contracts/protocol";
import {
  createHolderLinkScope,
  type HolderCatalog,
  type HolderLinkScope,
} from "@meridian/markup/links";
import type { DocumentLinksPort } from "./document-links.js";

export interface StaticDocumentCatalog {
  projectId: string;
  /** Read at every call, so replacing an entry moves, deletes or creates a document. */
  documents: readonly CatalogDocument[];
}

export function createStaticDocumentLinks(
  catalog: StaticDocumentCatalog = { projectId: "static", documents: [] },
): DocumentLinksPort {
  const scopeFor = (documentId: string): HolderLinkScope =>
    createHolderLinkScope(
      {
        uri: catalog.documents.find((entry) => entry.documentId === documentId)?.uri ?? null,
        projectId: catalog.projectId,
        view: { kind: "live" },
      },
      staticHolderCatalog(catalog),
      () => {},
    );
  return {
    async prepare() {},
    scopeFor,
    async registerAhead() {},
    revision: (cut, scope) => cutRevision(cut.version, scope, catalog),
  };
}

function staticHolderCatalog(catalog: StaticDocumentCatalog): HolderCatalog {
  const present = () => catalog.documents.filter((entry) => entry.presence !== "deleted");
  const reachable = (entry: CatalogDocument) => entry.readable && entry.nameable;
  return {
    document: (id) => catalog.documents.find((entry) => entry.documentId === id) ?? null,
    folder: () => null,
    folderAt: () => null,
    settlement: () => null,
    documentAt: (uri) => catalogTree(present()).documentAt(uri),
    documentFor: (uri) => catalogTree(present().filter(reachable)).documentAt(uri),
    assetAddress: () => null,
    assetFor: () => null,
  };
}

type CatalogNode = Walkable & { children: CatalogNode[]; document?: CatalogDocument };

/**
 * The catalog's addresses read as the tree reads them: folders are walked by segment (a document
 * `Kael` beside a folder `Kael~f051` leaves `Kael/Note` in the folder), the leaf is the exact name
 * or its alias, else the one document that differs only by a left-off extension. The catalog has
 * addresses, not parents, so the tree is rebuilt from them: each directory stands in as a folder
 * whose id begins with its `~` suffix.
 */
function catalogTree(documents: readonly CatalogDocument[]) {
  const dirs = new Map<string, CatalogNode>();
  const sourceOf = (parsed: Extract<ReturnType<typeof parseContextUri>, { ok: true }>) =>
    JSON.stringify([parsed.value.scheme, parsed.value.authority]);
  const dirAt = (source: string, path: string): CatalogNode => {
    const key = `${source}\0${path}`;
    let node = dirs.get(key);
    if (!node) {
      const slash = path.lastIndexOf("/");
      const { name, suffix } = readSegment(path.slice(slash + 1));
      node = { id: suffix ?? key, kind: "folder", name, suffix, trashed: false, children: [] };
      if (path !== "") dirAt(source, path.slice(0, Math.max(slash, 0))).children.push(node);
      dirs.set(key, node);
    }
    return node;
  };
  const leafOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));
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
  /** The folder reached by walking `segments` at folder level from the root of the address's source. */
  const walk = (source: string, segments: readonly string[]): CatalogNode | undefined => {
    let at = dirs.get(`${source}\0`);
    for (const segment of segments) {
      at = at && childAtSegment(at.children, segment, "folder");
    }
    return at;
  };
  return {
    documentAt(uri: string): CatalogDocument | null {
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
  };
}

/**
 * The cut's room version, holder and the whole catalog: coarser than the server's digest
 * (any catalog change counts), never finer, so a move always changes it.
 * FNV-1a, because this package also runs in the browser.
 */
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
      ]),
    ),
  );
  return `static:${hash.toString(16)}`;
}
