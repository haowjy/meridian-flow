import {
  type AheadRef,
  aheadAddress,
  type CatalogDocument,
  type CatalogFolder,
  canonicalContextUri,
  classifyWrittenLink,
  classifyWrittenSource,
  type DocumentRef,
  documentRef,
  type FolderRef,
  folderRef,
  formatParsedContextUri,
  type LinkCatalog,
  type LinkHolder,
  type LinkResolution,
  mintAheadRef,
  parseLinkRef,
  parseUnifiedContextUri,
  qualifyContextUriByHolder,
  type ResolvedDocumentHref,
  resolveDocumentHref,
  resolveStoredLink,
  resolveStoredLinkAddress,
  type SpelledHref,
  spellStoredLink,
  storedHref,
  type WrittenLinkClass,
} from "@meridian/contracts";
import type { Node as PMNode } from "prosemirror-model";

import { occurrenceIdentity, walkLinkOccurrences } from "./link-occurrences.js";
import type { DocumentLinkScope } from "./types.js";

export interface HolderLinkScope extends DocumentLinkScope {
  readonly holder: LinkHolder;
  resolve(
    link: { ref: string | null; href: string },
    address?: ResolvedDocumentHref | null,
  ): LinkResolution;
  documentFor(uri: string): CatalogDocument | null;
  folderFor(uri: string): CatalogFolder | null;
  assetFor(manuscriptPath: string): string | null;
  isLive(link: { ref: string; href: string }): boolean;
}

export type AssetAddress = { kind: "path"; path: string } | { kind: "last"; uri: string };

export interface HolderCatalog extends LinkCatalog {
  documentFor(uri: string): CatalogDocument | null | undefined;
  assetAddress(assetDocumentId: string): AssetAddress | null | undefined;
  assetFor(manuscriptUri: string): string | null | undefined;
}

const ASSET_PREFIX = "asset:";

export const UNSPELLED_UPLOAD: SpelledHref = Object.freeze({ href: "", address: null });

export function createHolderLinkScope(
  holder: LinkHolder,
  catalog: HolderCatalog,
  onMiss: (what: string) => void = () => {},
): HolderLinkScope {
  const resolve = (
    link: { ref: string | null; href: string },
    address = resolveStoredLinkAddress(link, holder.uri),
  ): LinkResolution => {
    const resolution = resolveStoredLink(link, address, catalog);
    if (resolution.kind === "unknown") onMiss(link.ref ?? link.href);
    return resolution;
  };
  return {
    holder,
    resolve,
    spellLink: (attrs) => spellStoredLink(attrs, holder, resolve(attrs), "holder"),
    spellSource(attrs): SpelledHref {
      if (attrs.src.startsWith(ASSET_PREFIX)) {
        const address = catalog.assetAddress(attrs.src.slice(ASSET_PREFIX.length));
        if (address === undefined) onMiss(attrs.src);
        if (!address) return UNSPELLED_UPLOAD;
        return address.kind === "path"
          ? { href: address.path, address: canonicalContextUri("manuscript", address.path) }
          : {
              href: storedHref({ kind: "document", uri: address.uri }, ""),
              address: address.uri,
            };
      }
      const link = { ref: attrs.ref, href: attrs.src };
      const resolution =
        parseLinkRef(attrs.ref)?.kind === "folder" ? { kind: "gone" as const } : resolve(link);
      return spellStoredLink(link, holder, resolution, "manuscript-root");
    },
    documentFor(uri) {
      const document = catalog.documentFor(uri);
      if (document === undefined) onMiss(uri);
      return document ?? null;
    },
    folderFor(uri) {
      const folder = catalog.folderAt(uri);
      if (folder === undefined) onMiss(uri);
      return folder ?? null;
    },
    assetFor(manuscriptPath) {
      const parsed = parseUnifiedContextUri(manuscriptPath);
      if (!parsed.ok || parsed.value.scheme !== "manuscript") return null;
      const uri = parsed.value.normalized;
      const id = catalog.assetFor(uri);
      if (id === undefined) onMiss(uri);
      return id ?? null;
    },
    isLive(link) {
      const resolution = resolve(
        link.ref.startsWith(ASSET_PREFIX)
          ? { ref: `doc:${link.ref.slice(ASSET_PREFIX.length)}`, href: link.href }
          : link,
      );
      return resolution.kind === "document" || resolution.kind === "folder";
    },
  };
}

export type WrittenGrammar = "link" | "source";

export type FreshAssignment =
  | { kind: "literal" }
  | { kind: "document"; ref: DocumentRef; href: string }
  | { kind: "folder"; ref: FolderRef; href: string }
  | { kind: "folder-address"; href: string }
  | { kind: "ahead"; ref: AheadRef; href: string; address: string };

/**
 * Pass 3 of ref assignment, the same on server and client: classify; an
 * internal document address names the document `documentFor` finds there
 * (exact, then unique extension-omitted), while a directory address names the
 * folder `folderFor` finds there. Each is spelled with its target kind; a
 * missing document gets a fresh ahead ref at `aheadAddress`, while a missing
 * folder keeps its directory address. External and contextual hrefs, and a
 * scheme root (no address to mint for), stay literal.
 */
export function assignFreshLink(input: {
  href: string;
  grammar: WrittenGrammar;
  holderUri: string | null;
  documentFor: (uri: string) => { documentId: string; uri: string } | null;
  folderFor: (uri: string) => { folderId: string; uri: string } | null;
  mint?: () => AheadRef;
}): FreshAssignment {
  const classified =
    input.grammar === "link"
      ? classifyWrittenLink(input.href, input.holderUri)
      : classifyWrittenSource(input.href);
  if (classified.kind !== "internal") return { kind: "literal" };
  if (classified.target === "folder") {
    if (input.grammar === "source") return { kind: "literal" };
    const folder = input.folderFor(classified.uri);
    return folder
      ? {
          kind: "folder",
          ref: folderRef(folder.folderId),
          href: storedHref({ kind: "folder", uri: folder.uri }, classified.suffix),
        }
      : {
          kind: "folder-address",
          href: storedHref({ kind: "folder", uri: classified.uri }, classified.suffix),
        };
  }
  const document = input.documentFor(classified.uri);
  if (document)
    return {
      kind: "document",
      ref: documentRef(document.documentId),
      href: storedHref({ kind: "document", uri: document.uri }, classified.suffix),
    };
  const address = aheadAddress(classified.uri, input.grammar);
  if (!address) return { kind: "literal" };
  const ref = (input.mint ?? mintAheadRef)();
  return {
    kind: "ahead",
    ref,
    href: storedHref({ kind: "document", uri: address }, classified.suffix),
    address,
  };
}

/**
 * A written href as it is bound: a bare `uploads://name` means the writing chat's file only while
 * read from that chat, and a document outlives it, so a freshly written one is qualified to that
 * chat (`uploads://@<chat>/name`). Preparation (`writtenAddresses`) and assignment
 * (`assignFreshLink` callers) both read the href through here, so the address loaded is the
 * address bound.
 */
export function qualifyWrittenHref(href: string, uploadsChat: string | undefined): string {
  if (!uploadsChat) return href;
  const resolved = resolveDocumentHref(href, null);
  if (!resolved) return href;
  const uri = qualifyContextUriByHolder(
    resolved.uri,
    formatParsedContextUri("uploads", "_", { kind: "chat", chatRef: uploadsChat }),
  );
  return uri === resolved.uri ? href : storedHref({ kind: resolved.kind, uri }, resolved.suffix);
}

/**
 * The decoded addresses written links and sources in `blocks` may resolve to:
 * what a host must load before assigning their refs. Links resolve against the
 * holder, sources under the manuscript-root grammar; both after
 * `qualifyWrittenHref`.
 */
export function writtenAddresses(
  blocks: readonly PMNode[],
  holderUri: string | null,
  uploadsChat?: string,
): ResolvedDocumentHref[] {
  const out = new Map<string, ResolvedDocumentHref>();
  for (const { kind, attrs } of walkLinkOccurrences(blocks)) {
    const href = qualifyWrittenHref(attrs.href, uploadsChat);
    const target =
      kind === "link"
        ? internalTarget(classifyWrittenLink(href, holderUri))
        : writtenSourceTarget(href);
    if (target) out.set(`${target.kind}:${target.uri}`, target);
  }
  return [...out.values()];
}

/**
 * Where each `ahead:` ref in `blocks` points now. Only a settled ref names a document: a copy
 * reads these from the same scope that spelled its cut, so it can remap a settled ref like a
 * `doc:` one.
 */
export function settledAheads(
  blocks: readonly PMNode[],
  scope: Pick<HolderLinkScope, "resolve">,
): ReadonlyMap<string, string> {
  const settled = new Map<string, string>();
  for (const occurrence of walkLinkOccurrences(blocks)) {
    const identity = occurrenceIdentity(occurrence);
    if (!identity?.startsWith("ahead:")) continue;
    const resolution = scope.resolve({ ref: identity, href: occurrence.attrs.href });
    if (resolution.kind === "document" && resolution.document) {
      settled.set(identity, resolution.document.documentId);
    }
  }
  return settled;
}

export function writtenSourceTarget(src: string): ResolvedDocumentHref | null {
  const written = classifyWrittenSource(src);
  return written.kind === "internal" && written.target === "document"
    ? { kind: "document", uri: written.uri, suffix: written.suffix }
    : null;
}

function internalTarget(written: WrittenLinkClass): ResolvedDocumentHref | null {
  return written.kind === "internal"
    ? { kind: written.target, uri: written.uri, suffix: written.suffix }
    : null;
}
