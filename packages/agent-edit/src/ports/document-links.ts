/**
 * Host port for link and image-source spelling and ref assignment (contract §4.3).
 *
 * The host owns the document tree. Before every synchronous render, assign or
 * apply block, agent-edit awaits `prepare` with everything that block may
 * spell or assign; `scopeFor` then answers synchronously for one holder in one
 * view. Rules live in `@meridian/contracts` (`resolveStoredLink`,
 * `spellStoredLink`); `createHolderLinkScope` applies them over any catalog,
 * so the server adapter and the in-memory one cannot disagree.
 */
import {
  type AheadRef,
  type CatalogDocument,
  classifyWrittenLink,
  classifyWrittenSource,
  type LinkCatalog,
  type LinkHolder,
  type LinkResolution,
  parseContextUri,
  resolveStoredLink,
  type SpelledHref,
  spellStoredLink,
} from "@meridian/contracts";
import { type DocumentLinkScope, type PMNode, walkLinkOccurrences } from "@meridian/markup";
import type * as Y from "yjs";
import type { ShownLink } from "../links/correspondence.js";
import type { WriteContext } from "../tool/types.js";

/** One holder's synchronous view over a prepared snapshot. */
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

export interface LinkPrepareRequest {
  documentId: string;
  /** Docs the next synchronous block serializes or assigns against (old runtime, overlays). */
  docs: readonly Y.Doc[];
  /** Freshly parsed nodes whose written addresses ref assignment may resolve. */
  written?: readonly PMNode[];
  /**
   * Nodes that already carry stored attrs and will be spelled as stored:
   * copies, and a host's bound write (`WriteContext.boundNodes`).
   */
  stored?: readonly PMNode[];
  /** Refs no doc carries yet that will be spelled (ahead refs this write registered). */
  refs?: readonly string[];
  /** Decoded addresses to load (a registered ahead ref's own address). */
  addresses?: readonly string[];
  shown?: readonly ShownLink[];
  context?: WriteContext;
}

export interface AheadMint {
  ref: AheadRef;
  /** aheadAddress(...) result: decoded, canonical, with an extension. */
  address: string;
  /** The holder scope's project at mint time: the registry's namespace. */
  holderProjectId: string;
}

export interface DocumentLinksPort {
  /** One batched load; awaited before every synchronous render, assign or apply block. */
  prepare(request: LinkPrepareRequest): Promise<void>;
  /** Synchronous; holder and view come from the arguments, the snapshot from the open scope. */
  scopeFor(documentId: string, context: WriteContext | undefined): HolderLinkScope;
  /** Independent durable registration (§6). Throws if called inside a DB transaction. */
  registerAhead(mints: readonly AheadMint[]): Promise<void>;
  /** View revision (§8), synchronous with the render or apply it identifies. */
  revision(doc: Y.Doc, scope: HolderLinkScope): string;
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
