/**
 * Ref assignment: binding written link and source attrs to stored ones, after
 * parse (contract §5.2).
 *
 * Parse is pure syntax; everything that needs the document tree happens here,
 * over a prepared holder scope. Each written occurrence takes, in order: the
 * ref of the old occurrence it continues (pass 1), the ref the model was
 * last shown at its address (pass 2), or a fresh classify, resolve or mint
 * (pass 3). The shipped image rule (`asset:`) runs first.
 */
import {
  type AheadRef,
  aheadAddress,
  classifyWrittenLink,
  classifyWrittenSource,
  documentRef,
  mintAheadRef,
  resolveDocumentHref,
  splitDocumentHrefSuffix,
  storedHref,
} from "@meridian/contracts";
import { type LinkOccurrence, type PMNode, walkLinkOccurrences } from "@meridian/markup";
import { Fragment } from "prosemirror-model";
import { type AheadMint, type HolderLinkScope, writtenSourceUri } from "../ports/document-links.js";
import { type Binding, correspondLinks, type ShownLink } from "./correspondence.js";
import {
  restoreOutsideSplice,
  type SpliceFallback,
  type SpliceRestoreInput,
} from "./find-splice.js";
import { type OccurrenceAttrs, rebuildOccurrences } from "./occurrences.js";

export interface AssignInput {
  /** Occurrences in the replaced span of the current document (empty for create/insert). */
  old: readonly LinkOccurrence[];
  /** Parsed nodes of the replaced span. */
  written: readonly PMNode[];
  scope: HolderLinkScope;
  /** The holder document, recorded on every ahead ref minted for it. */
  holderDocumentId: string;
  shown: readonly ShownLink[];
  /** Default `mintAheadRef`; injected only by tests. */
  mint?: () => AheadRef;
}

export interface AssignResult {
  nodes: PMNode[];
  minted: AheadMint[];
}

/** Bind written nodes against the occurrences they replace. Synchronous, pure over the scope. */
export function assignLinkRefs(input: AssignInput): AssignResult {
  const blocks = bindSources(input.written, input.scope);
  const written = walkLinkOccurrences(blocks);
  const { attrs, minted } = bindOccurrences({ ...input, written });
  return { nodes: rebuildOccurrences(blocks, written, attrs), minted };
}

export interface BindOccurrencesInput {
  old: readonly LinkOccurrence[];
  /** Written occurrences, already past the `asset:` rule. */
  written: readonly LinkOccurrence[];
  scope: HolderLinkScope;
  holderDocumentId: string;
  shown: readonly ShownLink[];
  mint?: () => AheadRef;
}

/**
 * The attrs each written occurrence stores (index-aligned with `written`),
 * and the ahead refs minted for them. Links and sources (images, figures)
 * correspond separately: each kind spells under its own address grammar.
 */
export function bindOccurrences(input: BindOccurrencesInput): {
  attrs: OccurrenceAttrs[];
  minted: AheadMint[];
} {
  const minted: AheadMint[] = [];
  const mint = input.mint ?? mintAheadRef;
  const attrs = input.written.map((occurrence) => occurrence.attrs);
  for (const kind of ["link", "source"] as const) {
    const grammar = GRAMMARS[kind];
    const isKind = (occurrence: LinkOccurrence) =>
      (occurrence.kind === "link") === (kind === "link");
    const writtenIndexes = input.written
      .map((occurrence, index) => ({ occurrence, index }))
      .filter(({ occurrence }) => isKind(occurrence) && !isAsset(occurrence));
    if (writtenIndexes.length === 0) continue;
    const old = input.old.filter((occurrence) => isKind(occurrence) && !isAsset(occurrence));
    const bound = bindKind({
      grammar,
      old,
      written: writtenIndexes.map(({ occurrence }) => occurrence),
      scope: input.scope,
      holderDocumentId: input.holderDocumentId,
      shown: input.shown,
      mint,
      minted,
    });
    writtenIndexes.forEach(({ index }, position) => {
      attrs[index] = bound[position] as OccurrenceAttrs;
    });
  }
  return { attrs, minted };
}

interface Grammar {
  /** Written href → decoded canonical address, ignoring classification; null if none. */
  address(href: string, holderUri: string | null): { uri: string; suffix: string } | null;
  /**
   * The address passes 1 and 2 compare a written href by. A written link with
   * no extension names the default-extension address, the spelling ahead
   * minting stores, so `ch12` still continues a link shown as `ch12.md` after
   * that document moved. Pass 3 keeps its exact-then-unique-extension resolve.
   */
  correspondenceKey(href: string, holderUri: string | null): string | null;
  /** Pass 3's classification. */
  classify(href: string, holderUri: string | null): ReturnType<typeof classifyWrittenLink>;
  spell(scope: HolderLinkScope, attrs: OccurrenceAttrs): string | null;
  aheadKind: "link" | "source";
}

const GRAMMARS: Record<"link" | "source", Grammar> = {
  link: {
    address: (href, holderUri) => resolveDocumentHref(href, holderUri),
    correspondenceKey(href, holderUri) {
      const uri = resolveDocumentHref(href, holderUri)?.uri;
      return uri ? (aheadAddress(uri, "link") ?? uri) : null;
    },
    classify: classifyWrittenLink,
    spell: (scope, attrs) => scope.spellLink({ href: attrs.href, ref: attrs.ref }).address,
    aheadKind: "link",
  },
  source: {
    address(href) {
      const uri = writtenSourceUri(href);
      return uri ? { uri, suffix: splitDocumentHrefSuffix(href).suffix } : null;
    },
    correspondenceKey: (href) => writtenSourceUri(href),
    classify: (href) => classifyWrittenSource(href),
    spell: (scope, attrs) => scope.spellSource({ src: attrs.href, ref: attrs.ref }).address,
    aheadKind: "source",
  },
};

function bindKind(input: {
  grammar: Grammar;
  old: readonly LinkOccurrence[];
  written: readonly LinkOccurrence[];
  scope: HolderLinkScope;
  holderDocumentId: string;
  shown: readonly ShownLink[];
  mint: () => AheadRef;
  minted: AheadMint[];
}): OccurrenceAttrs[] {
  const { grammar, scope } = input;
  const holderUri = scope.holder.uri;
  // Null-ref occurrences (contextual, external) never enter correspondence.
  const referenced = input.old.filter((occurrence) => occurrence.attrs.ref !== null);
  const contextual = input.old.filter((occurrence) => occurrence.attrs.ref === null);
  const bindings: Binding[] = correspondLinks({
    old: referenced.map((occurrence) => {
      const ref = occurrence.attrs.ref as string;
      return {
        label: occurrence.label,
        ref,
        current: grammar.spell(scope, occurrence.attrs) ?? "",
        live: scope.isLive(ref),
      };
    }),
    written: input.written.map((occurrence) => ({
      label: occurrence.label,
      href: occurrence.attrs.href,
    })),
    shown: input.shown,
    holderUri: holderUri ?? "",
    normalize: (href, base) => grammar.correspondenceKey(href, base || null),
    isLive: (ref) => scope.isLive(ref),
  });
  const contextualTaken = new Set<number>();
  return input.written.map((occurrence, index) => {
    const binding = bindings[index] ?? { pass: 3 };
    const writtenSuffix = suffixOf(grammar, occurrence.attrs.href, holderUri);
    if (binding.pass === 1) {
      const old = referenced[binding.occurrence] as LinkOccurrence;
      return continued(grammar, scope, old.attrs, occurrence.attrs, writtenSuffix);
    }
    // A written link equal to a contextual old one stays contextual (no churn).
    const twin = contextual.findIndex(
      (old, position) =>
        !contextualTaken.has(position) &&
        old.attrs.href === occurrence.attrs.href &&
        old.attrs.title === occurrence.attrs.title,
    );
    if (twin >= 0) {
      contextualTaken.add(twin);
      return (contextual[twin] as LinkOccurrence).attrs;
    }
    if (binding.pass === 2) {
      // The binding came from a showing, so a latest showing always exists.
      const address =
        currentUri(scope, binding.ref) ?? latestShownAddress(input.shown, binding.ref);
      return {
        ref: binding.ref,
        title: occurrence.attrs.title,
        href: storedHref(address, writtenSuffix),
      };
    }
    return fresh(input, occurrence);
  });
}

/**
 * Pass 1's attribute policy: an unchanged link keeps its old attrs verbatim,
 * so it emits no format operation; a title or suffix edit applies.
 */
function continued(
  grammar: Grammar,
  scope: HolderLinkScope,
  old: OccurrenceAttrs,
  written: OccurrenceAttrs,
  writtenSuffix: string,
): OccurrenceAttrs {
  const oldSuffix = splitDocumentHrefSuffix(old.href).suffix;
  if (written.title === old.title && writtenSuffix === oldSuffix) return old;
  const ref = old.ref as string;
  const address =
    currentUri(scope, ref) ??
    grammar.address(splitDocumentHrefSuffix(old.href).path, null)?.uri ??
    null;
  return {
    ref,
    title: written.title,
    href: address
      ? storedHref(address, writtenSuffix)
      : splitDocumentHrefSuffix(old.href).path + writtenSuffix,
  };
}

/** Pass 3: classify, then resolve in this view, then mint an ahead ref. */
function fresh(
  input: {
    grammar: Grammar;
    scope: HolderLinkScope;
    holderDocumentId: string;
    mint: () => AheadRef;
    minted: AheadMint[];
  },
  occurrence: LinkOccurrence,
): OccurrenceAttrs {
  const { grammar, scope } = input;
  const written = occurrence.attrs;
  const literal = { ref: null, href: written.href, title: written.title };
  const classified =
    grammar.aheadKind === "source"
      ? sourceClass(written.href)
      : grammar.classify(written.href, scope.holder.uri);
  if (classified.kind !== "internal") return literal;
  const document = scope.documentFor(classified.uri);
  if (document) {
    return {
      ref: documentRef(document.documentId),
      title: written.title,
      href: storedHref(document.uri, classified.suffix),
    };
  }
  const address = aheadAddress(classified.uri, grammar.aheadKind);
  if (!address) return literal;
  const ref = input.mint();
  input.minted.push({ ref, address, holderDocumentId: input.holderDocumentId });
  return { ref, title: written.title, href: storedHref(address, classified.suffix) };
}

/** A source the href grammar cannot decode is still a bare manuscript path (shipped rule). */
function sourceClass(src: string): ReturnType<typeof classifyWrittenSource> {
  const classified = classifyWrittenSource(src);
  if (classified.kind !== "external") return classified;
  const uri = writtenSourceUri(src);
  return uri ? { kind: "internal", uri, suffix: splitDocumentHrefSuffix(src).suffix } : classified;
}

/** Where a ref leads now: its live document's address, or an unsettled ahead ref's own. */
function currentUri(scope: HolderLinkScope, ref: string): string | null {
  const resolution = scope.resolve({ ref, href: "" });
  if (resolution.kind === "document") return resolution.document.uri;
  return null;
}

function latestShownAddress(shown: readonly ShownLink[], ref: string): string {
  let latest: ShownLink | undefined;
  for (const entry of shown)
    if (entry.ref === ref && (!latest || entry.at > latest.at)) latest = entry;
  return latest?.address ?? "";
}

function suffixOf(grammar: Grammar, href: string, holderUri: string | null): string {
  return grammar.address(href, holderUri)?.suffix ?? splitDocumentHrefSuffix(href).suffix;
}

function isAsset(occurrence: LinkOccurrence): boolean {
  return occurrence.kind !== "link" && occurrence.attrs.href.startsWith("asset:");
}

/**
 * The shipped image rule: a written `image`/`figure` source naming a picture
 * the project knows becomes `asset:<id>`, so the reference survives moves. A
 * source the scope cannot claim stays as written; guessing an id would store
 * a reference that can never render.
 */
export function bindSources(
  blocks: readonly PMNode[],
  scope: Pick<HolderLinkScope, "assetFor">,
): PMNode[] {
  return blocks.map((block) => bindNode(block, scope));
}

function bindNode(node: PMNode, scope: Pick<HolderLinkScope, "assetFor">): PMNode {
  if (node.type.name === "image" || node.type.name === "figure") {
    const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
    const uri = writtenSourceUri(src);
    const assetId = uri ? scope.assetFor(uri) : null;
    if (!assetId) return node;
    return node.type.create(
      { ...node.attrs, src: `asset:${assetId}`, ref: null },
      node.content,
      node.marks,
    );
  }
  if (node.isLeaf) return node;
  let changed = false;
  const children: PMNode[] = [];
  node.forEach((child) => {
    const bound = bindNode(child, scope);
    if (bound !== child) changed = true;
    children.push(bound);
  });
  return changed ? node.copy(Fragment.fromArray(children)) : node;
}

/** The write path's binder: one per command, over one prepared scope and one set of showings. */
export interface WriteLinkAssigner {
  /** Bind the nodes written over `old` (empty for an insert or a create). */
  bindSpan(old: readonly PMNode[], written: readonly PMNode[]): PMNode[];
  /**
   * Bind a formatted find's parsed spliced group: occurrences outside the
   * splice keep their old attrs, only the inside ones are assigned (§5.4).
   */
  bindSplice(input: Omit<SpliceRestoreInput, "prepare" | "bind">): PMNode[];
  /** Every ahead ref minted so far; the handler registers them before applying. */
  readonly minted: readonly AheadMint[];
}

export function createWriteLinkAssigner(input: {
  scope: HolderLinkScope;
  holderDocumentId: string;
  shown: readonly ShownLink[];
  mint?: () => AheadRef;
  /** Hears each splice that fell back to whole-group binding (possible format churn there). */
  onSpliceFallback?: (reason: SpliceFallback) => void;
}): WriteLinkAssigner {
  const minted: AheadMint[] = [];
  const common = {
    scope: input.scope,
    holderDocumentId: input.holderDocumentId,
    shown: input.shown,
    ...(input.mint ? { mint: input.mint } : {}),
  };
  const bindSpan = (old: readonly PMNode[], written: readonly PMNode[]) => {
    const result = assignLinkRefs({ ...common, old: walkLinkOccurrences(old), written });
    minted.push(...result.minted);
    return result.nodes;
  };
  return {
    minted,
    bindSpan,
    bindSplice(splice) {
      const restored = restoreOutsideSplice({
        ...splice,
        prepare: (blocks) => bindSources(blocks, input.scope),
        bind(old, written) {
          const result = bindOccurrences({ ...common, old, written });
          minted.push(...result.minted);
          return result.attrs;
        },
      });
      if ("nodes" in restored) return restored.nodes;
      input.onSpliceFallback?.(restored.fallback);
      return bindSpan(splice.oldGroup, splice.parsed.blocks);
    },
  };
}
