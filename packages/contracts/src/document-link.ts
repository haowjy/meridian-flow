/**
 * Stored-link resolution, written-link classification, and canonical spelling.
 *
 * Pure and synchronous. Each host implements `LinkCatalog` over its own data
 * (the server's prepared scope snapshot, the client's linkable-document
 * index); the rules themselves live only here, so server and client cannot
 * disagree about what a stored link names or how it is spelled.
 *
 * Two encodings meet here. An address (`CatalogDocument.uri`, a classified
 * `uri`, `aheadAddress`, registry keys) is a decoded canonical Context URI. A
 * stored `href`/`src` is an escaped wire spelling, built only by `storedHref`.
 */
import { isProjectScopedScheme, parseContextUri } from "./context-uri.js";
import {
  documentPathKey,
  type LinkAddress,
  type ResolvedDocumentHref,
  resolveDocumentHref,
  spellDocumentHref,
  splitDocumentHrefSuffix,
} from "./document-href.js";
import { parseLinkRef } from "./document-ref.js";
import type { ResolvedContextOwner } from "./protocol/context-owner.js";

/** The tree a link is read in: live, or one branch's view (the live tree plus what it created). */
export type LinkView = { kind: "live" } | { kind: "branch"; branchId: string };

export interface LinkHolder {
  /** Canonical URI of the holder in this view; null for chat (no holder). */
  uri: string | null;
  projectId: string;
  view: LinkView;
}

export interface CatalogDocument {
  documentId: string;
  /** Resolved storage owner; project and personal documents have a null Work owner. */
  owner: ResolvedContextOwner;
  projectId: string;
  /** Decoded canonical absolute URI in the catalog's view, with extension. */
  uri: string;
  /**
   * live: in the live tree; branch: a hidden document in a pending file tree;
   * deleted: soft-deleted, at its last address.
   */
  presence: "live" | "branch" | "deleted";
  /**
   * Present iff presence is "branch": the branch holding the document, the reader's own
   * if it uses the document, otherwise the oldest active branch that does.
   */
  branch?: { branchId: string; workId: string | null };
  /** The reader may read it (file policy). False is answered exactly like a missing row. */
  readable: boolean;
  /** Nameable from the holder: same project, or the reader's personal `user://` space. */
  nameable: boolean;
}

export interface CatalogFolder {
  folderId: string;
  /** Decoded canonical absolute URI, without a trailing slash. */
  uri: string;
  readable: boolean;
  nameable: boolean;
}

export interface LinkCatalog {
  /** undefined = not loaded (a snapshot miss); null = loaded and unknown. */
  document(documentId: string): CatalogDocument | null | undefined;
  /** The folder identity, or null when gone; undefined when the snapshot did not load it. */
  folder(folderId: string): CatalogFolder | null | undefined;
  /** The folder at an exact canonical address, or null; undefined when not loaded. */
  folderAt(uri: string): CatalogFolder | null | undefined;
  /** Settled document id; null = registered and unsettled or not registered; undefined = not loaded. */
  settlement(aheadId: string): string | null | undefined;
  /** The document at an exact canonical address in this view, or null; undefined = not loaded. */
  documentAt(uri: string): CatalogDocument | null | undefined;
}

export type LinkResolution =
  /**
   * Rules 1 and 3: a document the reader can name and read. `settled` marks
   * rule 3, an ahead ref answered through its settlement, which never again
   * answers by address.
   */
  | { kind: "document"; document: CatalogDocument; inBranch: boolean; settled?: true }
  | { kind: "folder"; folder: CatalogFolder }
  /** Rule 2 (and 3, `settled`, when the settled document is gone). */
  | { kind: "gone"; settled?: true; documentId?: string }
  /** Rule 4: an unsettled ahead ref with nothing at its address. */
  | { kind: "ahead"; uri: string; suffix: string }
  /** Rule 5: no ref; the host applies today's address rules. */
  | { kind: "address" }
  /** A snapshot miss: spell the stored href and report. */
  | { kind: "unknown" };

/**
 * The address written by one stored link, resolved relative to its holder once.
 * Hosts carry this kind-aware value through lookup instead of reconstructing a
 * document address from the href later.
 */
export function resolveStoredLinkAddress(
  link: { href: string },
  holderUri: string | null,
): ResolvedDocumentHref | null {
  return resolveDocumentHref(link.href, holderUri);
}

/**
 * The resolution rules, in order (design "Resolution"). They do not depend on
 * the holder: what a reader may name is the catalog's `nameable`, and only
 * spelling (`spellStoredLink`) reads the holder.
 */
export function resolveStoredLink(
  link: { ref: string | null; href: string },
  address: ResolvedDocumentHref | null,
  catalog: LinkCatalog,
): LinkResolution {
  if (link.ref === null) {
    if (address?.kind !== "folder") return { kind: "address" };
    return resolveFolder(catalog.folderAt(address.uri));
  }
  const ref = parseLinkRef(link.ref);
  // A malformed ref names nothing the reader can reach; it never falls back to
  // the address, so nothing can capture it.
  if (!ref) return { kind: "gone" };
  if (ref.kind === "doc") return resolveDocument(catalog.document(ref.documentId));
  if (ref.kind === "folder") return resolveFolder(catalog.folder(ref.folderId));

  const settled = catalog.settlement(ref.aheadId);
  if (settled === undefined) return { kind: "unknown" };
  if (settled !== null) {
    const resolution = resolveDocument(catalog.document(settled));
    return resolution.kind === "unknown" ? resolution : { ...resolution, settled: true };
  }

  const stored = address;
  if (stored?.kind !== "document") return { kind: "gone" };
  const parsed = parseContextUri(stored.uri);
  const uri = parsed.ok
    ? stored.uri.slice(0, -parsed.value.path.length) + documentPathKey(parsed.value.path)
    : stored.uri;
  // Prepare tracked the stored spelling. Canonicalization changes the shown
  // ahead address, not the snapshot key that was loaded for this occurrence.
  const occupant = catalog.documentAt(stored.uri);
  if (occupant === undefined) return { kind: "unknown" };
  // A document the reader cannot name or read is answered as nothing there:
  // an unsettled ref must not reveal what sits at its address.
  if (occupant && nameableLive(occupant)) return documentResolution(occupant);
  return { kind: "ahead", uri, suffix: stored.suffix };
}

function resolveFolder(
  folder: CatalogFolder | null | undefined,
): Extract<LinkResolution, { kind: "folder" | "gone" | "unknown" }> {
  if (folder === undefined) return { kind: "unknown" };
  return folder?.readable && folder.nameable ? { kind: "folder", folder } : { kind: "gone" };
}

function resolveDocument(
  document: CatalogDocument | null | undefined,
): Extract<LinkResolution, { kind: "document" | "gone" | "unknown" }> {
  if (document === undefined) return { kind: "unknown" };
  if (document && nameableLive(document)) return documentResolution(document);
  return document?.presence === "deleted"
    ? { kind: "gone", documentId: document.documentId }
    : { kind: "gone" };
}

function nameableLive(document: CatalogDocument): boolean {
  return document.presence !== "deleted" && document.readable && document.nameable;
}

function documentResolution(
  document: CatalogDocument,
): Extract<LinkResolution, { kind: "document" }> {
  return { kind: "document", document, inBranch: document.presence === "branch" };
}

export type WrittenLinkClass =
  | { kind: "external" }
  | { kind: "contextual" }
  /** Decoded canonical absolute address, and the still-escaped `?`/`#` suffix. */
  | { kind: "internal"; target: LinkAddress["kind"]; uri: string; suffix: string };

/**
 * The stored `href`/`src` for a ref-bearing link: the escaped full spelling of
 * a decoded canonical address plus its suffix. The only way to build one, so
 * `%`, a literal `%20` or a `#` in a filename round-trips through resolution.
 */
export function storedHref(address: LinkAddress, suffix: string): string {
  if (suffix && !/^[?#]/.test(suffix))
    throw new RangeError(`A stored href suffix starts with ? or #: ${suffix}`);
  return spellDocumentHref(null, address) + suffix;
}

/**
 * What a written href is, before any catalog is consulted. `holderUri` null =
 * chat. Anything the href grammar cannot read as a document address is
 * `external` (kept as written, never given a ref). A Work-capable URI without
 * `@` authority, and a project-scheme link inside a personal `user://` holder,
 * are `contextual`: their meaning depends on the reading scope.
 */
export function classifyWrittenLink(href: string, holderUri: string | null): WrittenLinkClass {
  const resolved = resolveDocumentHref(href, holderUri);
  if (!resolved) return { kind: "external" };
  const target = parseContextUri(resolved.uri);
  if (!target.ok) return { kind: "external" };
  const { scheme, authority } = target.value;
  const holderScheme = holderUri ? parseContextUri(holderUri) : null;
  const contextual = !isProjectScopedScheme(scheme)
    ? authority.kind === "contextual"
    : holderScheme?.ok === true && holderScheme.value.scheme === "user" && scheme !== "user";
  return contextual
    ? { kind: "contextual" }
    : { kind: "internal", target: resolved.kind, uri: resolved.uri, suffix: resolved.suffix };
}

/** The grammar image and figure sources are written in: a bare source is manuscript-root-relative. */
export const IMAGE_SOURCE_BASE = "manuscript://";

// `resolveDocumentHref` and `spellDocumentHref` resolve against a holder's
// directory, so a holder sitting at the manuscript root stands in for the
// root itself. Only its directory is ever read.
const MANUSCRIPT_ROOT_HOLDER = `${IMAGE_SOURCE_BASE}_`;

/**
 * `classifyWrittenLink` for an `image`/`figure` source, under the
 * manuscript-root grammar: the whole source grammar, which every reader of a
 * written source (fresh assignment, address preloading, the editor's picture
 * key, link rows) takes as is. A source whose path does not decode (a raw `%`)
 * is a literal path, as the shipped image rule always read it. A
 * protocol-relative `//host/x.png` is the web.
 */
export function classifyWrittenSource(src: string): WrittenLinkClass {
  const classified = classifyWrittenLink(src, MANUSCRIPT_ROOT_HOLDER);
  const { path, suffix } = splitDocumentHrefSuffix(src);
  if (classified.kind === "internal" && classified.target === "folder") return { kind: "external" };
  if (classified.kind !== "external" || decodes(path)) return classified;
  const escaped = classifyWrittenLink(path.replaceAll("%", "%25") + suffix, MANUSCRIPT_ROOT_HOLDER);
  return escaped.kind === "internal" && escaped.target === "folder"
    ? { kind: "external" }
    : escaped;
}

function decodes(path: string): boolean {
  try {
    decodeURIComponent(path);
    return true;
  } catch {
    return false;
  }
}

export interface SpelledHref {
  /** What the wire shows. */
  href: string;
  /**
   * Canonical absolute address the reader was shown, no suffix; null for a
   * link with no identity (no ref, and not an upload's `asset:` source).
   */
  address: string | null;
}

/**
 * The wire spelling of a stored link for one holder: a resolvable ref spells
 * its target's current canonical path (relative within the holder's scheme
 * and authority, full otherwise, always with the extension) plus the stored
 * suffix; anything else spells the stored href byte for byte, so a reader
 * never learns where an unreachable target went.
 */
export function spellStoredLink(
  link: { ref: string | null; href: string },
  holder: LinkHolder,
  resolution: LinkResolution,
  grammar: "holder" | "manuscript-root",
): SpelledHref {
  const base = grammar === "holder" ? holder.uri : MANUSCRIPT_ROOT_HOLDER;
  switch (resolution.kind) {
    case "document":
      return {
        href:
          spellDocumentHref(base, { kind: "document", uri: resolution.document.uri }) +
          splitDocumentHrefSuffix(link.href).suffix,
        address: resolution.document.uri,
      };
    case "folder":
      return {
        href:
          spellDocumentHref(base, { kind: "folder", uri: resolution.folder.uri }) +
          splitDocumentHrefSuffix(link.href).suffix,
        address: resolution.folder.uri,
      };
    case "ahead":
      return {
        href:
          spellDocumentHref(base, { kind: "document", uri: resolution.uri }) + resolution.suffix,
        address: resolution.uri,
      };
    case "gone":
    case "unknown":
      return {
        href: link.href,
        address: link.ref === null ? null : (resolveDocumentHref(link.href, base)?.uri ?? null),
      };
    case "address":
      return { href: link.href, address: null };
  }
}
