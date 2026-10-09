/**
 * The link rules over one holder's catalog, for every host: the server's
 * prepared scope, agent-edit's in-memory port and the client's document index.
 *
 * Rules live in `@meridian/contracts` (`resolveStoredLink`, `spellStoredLink`,
 * `classifyWrittenLink`); this applies them over any `HolderCatalog`, and owns
 * pass 3 of ref assignment (`assignFreshLink`), so no host can disagree about
 * what a stored link names, how it is spelled, or what a written one binds to.
 */
import {
  type AheadRef,
  aheadAddress,
  type CatalogDocument,
  classifyWrittenLink,
  classifyWrittenSource,
  type DocumentRef,
  documentRef,
  type LinkCatalog,
  type LinkHolder,
  type LinkResolution,
  mintAheadRef,
  parseContextUri,
  resolveStoredLink,
  type SpelledHref,
  spellStoredLink,
  splitDocumentHrefSuffix,
  storedHref,
  type WrittenLinkClass,
} from "@meridian/contracts";
import type { Node as PMNode } from "prosemirror-model";

import { walkLinkOccurrences } from "./link-occurrences.js";
import type { DocumentLinkScope } from "./types.js";

/** One holder's synchronous view over a catalog. */
export interface HolderLinkScope extends DocumentLinkScope {
  readonly holder: LinkHolder;
  resolve(link: { ref: string | null; href: string }): LinkResolution;
  /** Pass 3 resolve: exact, then unique extension-omitted (matchDocumentPath), in this view. */
  documentFor(uri: string): CatalogDocument | null;
  /** Shipped image rule: an asset document id for a known manuscript image path, else null. */
  assetFor(manuscriptPath: string): string | null;
  /** Whether a stored link resolves to a live document now (an unsettled ahead ref by its href). */
  isLive(link: { ref: string; href: string }): boolean;
}

/**
 * A `LinkCatalog` plus the two lookups the scope adds: pass 3's
 * extension-omitted match and the `asset:` image rule. `undefined` always
 * means "not loaded" (a snapshot miss), `null` "loaded, nothing there".
 */
export interface HolderCatalog extends LinkCatalog {
  /** Exact, then unique extension-omitted; nameable, readable and present in this view. */
  documentFor(uri: string): CatalogDocument | null | undefined;
  /** The manuscript-root path an `asset:<id>` source spells, or null (spell the ref). */
  assetPath(assetDocumentId: string): string | null | undefined;
  /** The asset id a written manuscript image path names, or null (keep it literal). */
  assetFor(manuscriptUri: string): string | null | undefined;
}

const ASSET_PREFIX = "asset:";
/** Bare image sources are manuscript-root-relative (IMAGE_SOURCE_BASE). */
const MANUSCRIPT_SCHEME = /^manuscript:\/\//i;

/**
 * The rules over a catalog. `onMiss` hears every lookup the catalog never
 * loaded; the answer then is the stored spelling, so a miss is visible but
 * never wrong.
 */
export function createHolderLinkScope(
  holder: LinkHolder,
  catalog: HolderCatalog,
  onMiss: (what: string) => void = () => {},
): HolderLinkScope {
  const resolve = (link: { ref: string | null; href: string }): LinkResolution => {
    const resolution = resolveStoredLink(link, catalog);
    if (resolution.kind === "unknown") onMiss(link.ref ?? link.href);
    return resolution;
  };
  return {
    holder,
    resolve,
    spellLink: (attrs) => spellStoredLink(attrs, holder, resolve(attrs), "holder"),
    spellSource(attrs): SpelledHref {
      if (attrs.src.startsWith(ASSET_PREFIX)) {
        const id = attrs.src.slice(ASSET_PREFIX.length);
        const path = catalog.assetPath(id);
        if (path === undefined) onMiss(attrs.src);
        return path ? { href: path, address: null } : { href: attrs.src, address: null };
      }
      const link = { ref: attrs.ref, href: attrs.src };
      return spellStoredLink(link, holder, resolve(link), "manuscript-root");
    },
    documentFor(uri) {
      const document = catalog.documentFor(uri);
      if (document === undefined) onMiss(uri);
      return document ?? null;
    },
    assetFor(manuscriptPath) {
      const uri = MANUSCRIPT_SCHEME.test(manuscriptPath)
        ? manuscriptPath
        : `manuscript://${manuscriptPath}`;
      if (
        /^[a-z][a-z0-9+.-]*:\/\//i.test(manuscriptPath) &&
        !MANUSCRIPT_SCHEME.test(manuscriptPath)
      )
        return null;
      const id = catalog.assetFor(uri);
      if (id === undefined) onMiss(uri);
      return id ?? null;
    },
    isLive: (link) => resolve(link).kind === "document",
  };
}

/** The two written-address grammars: a link reads against its holder, a source against the manuscript root. */
export type WrittenGrammar = "link" | "source";

/**
 * What a written href or source is, before any catalog is consulted. A source
 * the href grammar cannot decode (a raw `%`) is still a bare manuscript path,
 * as the shipped image rule always has.
 */
export function classifyWrittenHref(
  href: string,
  grammar: WrittenGrammar,
  holderUri: string | null,
): WrittenLinkClass {
  if (grammar === "link") return classifyWrittenLink(href, holderUri);
  const classified = classifyWrittenSource(href);
  if (classified.kind !== "external") return classified;
  const uri = writtenSourceUri(href);
  return uri ? { kind: "internal", uri, suffix: splitDocumentHrefSuffix(href).suffix } : classified;
}

/** Pass 3's answer for one written href; `literal` keeps it as written with no ref. */
export type FreshAssignment =
  | { kind: "literal" }
  | { kind: "document"; ref: DocumentRef; href: string }
  /** `address` is what the host registers the minted ref at (`aheadAddress`). */
  | { kind: "ahead"; ref: AheadRef; href: string; address: string };

/**
 * Pass 3 of ref assignment, the same on server and client: classify; an
 * internal address names the document `documentFor` finds there (exact, then
 * unique extension-omitted) and is spelled as its canonical address; else it
 * gets a fresh ahead ref at `aheadAddress`. External and contextual hrefs,
 * and a scheme root (no address to mint for), stay literal.
 */
export function assignFreshLink(input: {
  href: string;
  grammar: WrittenGrammar;
  holderUri: string | null;
  documentFor: (uri: string) => { documentId: string; uri: string } | null;
  /** Default `mintAheadRef`; injected only by tests. */
  mint?: () => AheadRef;
}): FreshAssignment {
  const classified = classifyWrittenHref(input.href, input.grammar, input.holderUri);
  if (classified.kind !== "internal") return { kind: "literal" };
  const document = input.documentFor(classified.uri);
  if (document)
    return {
      kind: "document",
      ref: documentRef(document.documentId),
      href: storedHref(document.uri, classified.suffix),
    };
  const address = aheadAddress(classified.uri, input.grammar);
  if (!address) return { kind: "literal" };
  const ref = (input.mint ?? mintAheadRef)();
  return { kind: "ahead", ref, href: storedHref(address, classified.suffix), address };
}

/**
 * The decoded addresses written links and sources in `blocks` may resolve to:
 * what a host must load before assigning their refs. Links resolve against the
 * holder; sources under the manuscript-root grammar, and a source the href
 * grammar cannot decode (a raw `%`) is read as a bare manuscript path, as the
 * shipped image rule always has.
 */
export function writtenAddresses(blocks: readonly PMNode[], holderUri: string | null): string[] {
  const out = new Set<string>();
  for (const occurrence of walkLinkOccurrences(blocks)) {
    const { href } = occurrence.attrs;
    if (occurrence.kind === "link") {
      const written = classifyWrittenLink(href, holderUri);
      if (written.kind === "internal") out.add(written.uri);
      continue;
    }
    const uri = writtenSourceUri(href);
    if (uri) out.add(uri);
  }
  return [...out];
}

/** A written image/figure source as a decoded manuscript-relative address, or null. */
export function writtenSourceUri(src: string): string | null {
  if (!src || src.startsWith(ASSET_PREFIX)) return null;
  const written = classifyWrittenSource(src);
  if (written.kind === "internal") return written.uri;
  if (written.kind === "external" && !/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    const raw = parseContextUri(src.split(/[?#]/)[0] ?? "");
    if (raw.ok && raw.value.scheme === "manuscript" && raw.value.path) return raw.value.normalized;
  }
  return null;
}
