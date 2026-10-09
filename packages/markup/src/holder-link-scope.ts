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
  resolveStoredLink,
  type SpelledHref,
  spellStoredLink,
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
  /**
   * Whether an identity leads to a live document now: a stored ref (an
   * unsettled ahead ref by its href) or an upload's `asset:<id>`.
   */
  isLive(link: { ref: string; href: string }): boolean;
}

/**
 * Where an upload is spelled. `path`: it holds its manuscript image path, read
 * against the manuscript root (the shipped rule). `last`: the last address its
 * own document row had in this project, spelled in full, as a gone link spells
 * its stored address; a deleted upload whose path another image now holds is
 * told apart from that image this way.
 */
export type AssetAddress = { kind: "path"; path: string } | { kind: "last"; uri: string };

/**
 * A `LinkCatalog` plus the two lookups the scope adds: pass 3's
 * extension-omitted match and the `asset:` image rule. `undefined` always
 * means "not loaded" (a snapshot miss), `null` "loaded, nothing there".
 */
export interface HolderCatalog extends LinkCatalog {
  /** Exact, then unique extension-omitted; nameable, readable and present in this view. */
  documentFor(uri: string): CatalogDocument | null | undefined;
  /** Where an `asset:<id>` source is spelled; null when this project knows no image row for the id. */
  assetAddress(assetDocumentId: string): AssetAddress | null | undefined;
  /** The asset id a written manuscript image path names, or null (keep it literal). */
  assetFor(manuscriptUri: string): string | null | undefined;
}

const ASSET_PREFIX = "asset:";

/**
 * An upload with no address this reader may be shown (no row, another
 * project's id, a snapshot miss): an empty destination, which carries no id
 * and binds to nothing when written back.
 */
export const UNSPELLED_UPLOAD: SpelledHref = Object.freeze({ href: "", address: null });
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
        const address = catalog.assetAddress(attrs.src.slice(ASSET_PREFIX.length));
        if (address === undefined) onMiss(attrs.src);
        // The upload's identity is its src, which no reader is ever shown.
        if (!address) return UNSPELLED_UPLOAD;
        return address.kind === "path"
          ? { href: address.path, address: `manuscript://${address.path}` }
          : { href: storedHref(address.uri, ""), address: address.uri };
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
    isLive: (link) =>
      resolve(
        link.ref.startsWith(ASSET_PREFIX)
          ? { ref: `doc:${link.ref.slice(ASSET_PREFIX.length)}`, href: link.href }
          : link,
      ).kind === "document",
  };
}

/** The two written-address grammars: a link reads against its holder, a source against the manuscript root. */
export type WrittenGrammar = "link" | "source";

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
  const classified =
    input.grammar === "link"
      ? classifyWrittenLink(input.href, input.holderUri)
      : classifyWrittenSource(input.href);
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
 * holder, sources under the manuscript-root grammar.
 */
export function writtenAddresses(blocks: readonly PMNode[], holderUri: string | null): string[] {
  const out = new Set<string>();
  for (const { kind, attrs } of walkLinkOccurrences(blocks)) {
    const uri =
      kind === "link"
        ? internalUri(classifyWrittenLink(attrs.href, holderUri))
        : writtenSourceUri(attrs.href);
    if (uri) out.add(uri);
  }
  return [...out];
}

/** A written image/figure source as a decoded internal address, or null. */
export function writtenSourceUri(src: string): string | null {
  return internalUri(classifyWrittenSource(src));
}

function internalUri(written: WrittenLinkClass): string | null {
  return written.kind === "internal" ? written.uri : null;
}
