import { canonicalContextUri, isProjectScopedScheme, parseContextUri } from "./context-uri.js";
import {
  documentPathKey,
  type LinkAddress,
  type ResolvedDocumentHref,
  resolveDocumentHref,
  spellDocumentHref,
  splitDocumentHrefSuffix,
} from "./document-href.js";
import { parseLinkRef } from "./document-ref.js";
import type { DraftId } from "./ids.js";
import type { ResolvedContextOwner } from "./protocol/context-owner.js";

export type LinkView = { kind: "live" } | { kind: "draft"; draftId: string };

export interface LinkHolder {
  uri: string | null;
  projectId: string;
  view: LinkView;
}

export interface CatalogDocument {
  documentId: string;
  owner: ResolvedContextOwner;
  projectId: string | null;
  uri: string;
  presence: "live" | "draft" | "deleted";
  draft?: { draftId: DraftId };
  readable: boolean;
  nameable: boolean;
}

export interface CatalogFolder {
  folderId: string;
  uri: string;
  readable: boolean;
  nameable: boolean;
}

export interface LinkCatalog {
  document(documentId: string): CatalogDocument | null | undefined;
  folder(folderId: string): CatalogFolder | null | undefined;
  folderAt(uri: string): CatalogFolder | null | undefined;
  settlement(aheadId: string): string | null | undefined;
  documentAt(uri: string): CatalogDocument | null | undefined;
}

export type LinkResolution =
  | { kind: "document"; document: CatalogDocument; inDraft: boolean; settled?: true }
  | { kind: "folder"; folder: CatalogFolder }
  | { kind: "gone"; settled?: true; documentId?: string }
  | { kind: "ahead"; uri: string; suffix: string }
  | { kind: "address" }
  | { kind: "unknown" };

export function resolveStoredLinkAddress(
  link: { href: string },
  holderUri: string | null,
): ResolvedDocumentHref | null {
  return resolveDocumentHref(link.href, holderUri);
}

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
  const occupant = catalog.documentAt(stored.uri);
  if (occupant === undefined) return { kind: "unknown" };
  // An unreadable or unnameable target must resolve gone; an unsettled ref must not reveal what sits at its address
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
  return { kind: "document", document, inDraft: document.presence === "draft" };
}

export type WrittenLinkClass =
  | { kind: "external" }
  | { kind: "contextual" }
  | { kind: "internal"; target: LinkAddress["kind"]; uri: string; suffix: string };

export function storedHref(address: LinkAddress, suffix: string): string {
  if (suffix && !/^[?#]/.test(suffix))
    throw new RangeError(`A stored href suffix starts with ? or #: ${suffix}`);
  return spellDocumentHref(null, address) + suffix;
}

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

const MANUSCRIPT_ROOT_HOLDER = canonicalContextUri("manuscript", "_");

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
  href: string;
  address: string | null;
}

// Unreachable links keep their stored href byte for byte so the reader never learns where the target went
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
