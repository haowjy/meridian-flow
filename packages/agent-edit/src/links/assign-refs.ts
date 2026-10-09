/**
 * Ref assignment: giving written link and source occurrences their stored attrs, after
 * parse (contract §5.2).
 *
 * Parse is pure syntax; everything that needs the document tree happens here,
 * over a prepared holder scope. Each written occurrence takes, in order: the
 * ref of the old occurrence it continues (pass 1), the ref the model was
 * last shown at its address (pass 2), or a fresh classify, resolve or mint
 * (pass 3). Pictures follow the same passes; the shipped image rule (`asset:`)
 * is part of pass 3, so a new occupant of a shown path never captures a
 * picture that continues its identity (L39).
 */
import {
  type AheadRef,
  aheadAddress,
  mintAheadRef,
  resolveDocumentHref,
  splitDocumentHrefSuffix,
  storedHref,
} from "@meridian/contracts";
import type { PMNode } from "@meridian/markup";
import {
  assignFreshLink,
  type HolderLinkScope,
  type LinkOccurrence,
  type WrittenGrammar,
  walkLinkOccurrences,
  writtenSourceUri,
} from "@meridian/markup/links";
import type { AheadMint } from "../ports/document-links.js";
import { correspondLinks, type LinkMatch, type ShownLink } from "./correspondence.js";
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
  shown: readonly ShownLink[];
  /** Default `mintAheadRef`; injected only by tests. */
  mint?: () => AheadRef;
}

export interface AssignResult {
  nodes: PMNode[];
  minted: AheadMint[];
}

/** Assign refs to written nodes against the occurrences they replace. Synchronous, pure over the scope. */
export function assignLinkRefs(input: AssignInput): AssignResult {
  const written = walkLinkOccurrences(input.written);
  const { attrs, minted } = assignOccurrences({ ...input, written });
  return { nodes: rebuildOccurrences(input.written, written, attrs), minted };
}

export interface AssignOccurrencesInput {
  old: readonly LinkOccurrence[];
  written: readonly LinkOccurrence[];
  scope: HolderLinkScope;
  shown: readonly ShownLink[];
  mint?: () => AheadRef;
}

/**
 * The attrs each written occurrence stores (index-aligned with `written`),
 * and the ahead refs minted for them. Links and sources (images, figures)
 * correspond separately: each kind spells under its own address grammar.
 */
export function assignOccurrences(input: AssignOccurrencesInput): {
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
    const assigned = assignKind({
      grammar,
      old,
      written: writtenIndexes.map(({ occurrence }) => occurrence),
      scope: input.scope,
      shown: input.shown,
      mint,
      minted,
    });
    writtenIndexes.forEach(({ index }, position) => {
      attrs[index] = assigned[position] as OccurrenceAttrs;
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
  spell(scope: HolderLinkScope, attrs: OccurrenceAttrs): string | null;
  kind: WrittenGrammar;
}

const GRAMMARS: Record<"link" | "source", Grammar> = {
  link: {
    address: (href, holderUri) => resolveDocumentHref(href, holderUri),
    correspondenceKey(href, holderUri) {
      const uri = resolveDocumentHref(href, holderUri)?.uri;
      return uri ? (aheadAddress(uri, "link") ?? uri) : null;
    },
    spell: (scope, attrs) => scope.spellLink({ href: attrs.href, ref: attrs.ref }).address,
    kind: "link",
  },
  source: {
    address(href) {
      const uri = writtenSourceUri(href);
      return uri ? { uri, suffix: splitDocumentHrefSuffix(href).suffix } : null;
    },
    correspondenceKey: (href) => writtenSourceUri(href),
    spell: (scope, attrs) => scope.spellSource({ src: attrs.href, ref: attrs.ref }).address,
    kind: "source",
  },
};

function assignKind(input: {
  grammar: Grammar;
  old: readonly LinkOccurrence[];
  written: readonly LinkOccurrence[];
  scope: HolderLinkScope;
  shown: readonly ShownLink[];
  mint: () => AheadRef;
  minted: AheadMint[];
}): OccurrenceAttrs[] {
  const { grammar, scope } = input;
  const holderUri = scope.holder.uri;
  // Null-ref occurrences (contextual, external) never enter correspondence.
  const referenced = input.old.filter((occurrence) => occurrence.attrs.ref !== null);
  const contextual = input.old.filter((occurrence) => occurrence.attrs.ref === null);
  const matches: LinkMatch[] = correspondLinks({
    old: referenced.map((occurrence) => {
      const ref = occurrence.attrs.ref as string;
      return {
        label: occurrence.label,
        ref,
        current: grammar.spell(scope, occurrence.attrs) ?? "",
        live: scope.isLive({ ref, href: occurrence.attrs.href }),
      };
    }),
    written: input.written.map((occurrence) => ({
      label: occurrence.label,
      href: occurrence.attrs.href,
    })),
    shown: input.shown,
    holderUri,
    normalize: (href, base) => grammar.correspondenceKey(href, base),
    isLive: (ref, address) => scope.isLive({ ref, href: address }),
  });
  const contextualTaken = new Set<number>();
  return input.written.map((occurrence, index) => {
    const match = matches[index] ?? { pass: 3 };
    const writtenSuffix = suffixOf(grammar, occurrence.attrs.href, holderUri);
    if (match.pass === 1) {
      const old = referenced[match.occurrence] as LinkOccurrence;
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
    if (match.pass === 2) {
      // The match came from a showing, so a latest showing always exists.
      const shownAddress = latestShownAddress(input.shown, match.ref);
      const address = currentUri(scope, { ref: match.ref, href: shownAddress }) ?? shownAddress;
      return {
        ref: match.ref,
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
    currentUri(scope, { ref, href: old.href }) ??
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

/**
 * Pass 3: a source naming a picture the project knows takes the shipped image
 * rule; anything else is markup's `assignFreshLink` in this view. A minted ref
 * is registered by the host.
 */
function fresh(
  input: {
    grammar: Grammar;
    scope: HolderLinkScope;
    mint: () => AheadRef;
    minted: AheadMint[];
  },
  occurrence: LinkOccurrence,
): OccurrenceAttrs {
  const { grammar, scope } = input;
  const { href, title } = occurrence.attrs;
  if (grammar.kind === "source") {
    const asset = assetFor(scope, href);
    if (asset) return { ref: null, href: `asset:${asset}`, title };
  }
  const assigned = assignFreshLink({
    href,
    grammar: grammar.kind,
    holderUri: scope.holder.uri,
    documentFor: (uri) => scope.documentFor(uri),
    mint: input.mint,
  });
  if (assigned.kind === "literal") return { ref: null, href, title };
  if (assigned.kind === "ahead")
    input.minted.push({
      ref: assigned.ref,
      address: assigned.address,
      holderProjectId: scope.holder.projectId,
    });
  return { ref: assigned.ref, title, href: assigned.href };
}

/**
 * Where a stored link leads now: its live document's address. An unsettled
 * ahead ref leads to a document only once one holds the address its href names.
 */
function currentUri(scope: HolderLinkScope, link: { ref: string; href: string }): string | null {
  const resolution = scope.resolve(link);
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
 * The shipped image rule: a written source naming a picture the project knows
 * becomes `asset:<id>`. A source the scope cannot claim is assigned like a
 * link; guessing an id would store a reference that can never render.
 */
function assetFor(scope: HolderLinkScope, src: string): string | null {
  const uri = writtenSourceUri(src);
  return uri ? scope.assetFor(uri) : null;
}

/** The write path's ref assigner: one per command, over one prepared scope and one set of showings. */
export interface WriteLinkAssigner {
  /** Assign refs to the nodes written over `old` (empty for an insert or a create). */
  assignSpan(old: readonly PMNode[], written: readonly PMNode[]): PMNode[];
  /**
   * Assign refs in a formatted find's parsed spliced group: occurrences outside the
   * splice keep their old attrs, only the inside ones are assigned (§5.4).
   */
  assignSplice(input: Omit<SpliceRestoreInput, "assignOccurrences">): PMNode[];
  /** Every ahead ref minted so far; the handler registers them before applying. */
  readonly minted: readonly AheadMint[];
}

export function createWriteLinkAssigner(input: {
  scope: HolderLinkScope;
  shown: readonly ShownLink[];
  mint?: () => AheadRef;
  /** Hears each splice that fell back to whole-group assignment (possible format churn there). */
  onSpliceFallback?: (reason: SpliceFallback) => void;
}): WriteLinkAssigner {
  const minted: AheadMint[] = [];
  const common = {
    scope: input.scope,
    shown: input.shown,
    ...(input.mint ? { mint: input.mint } : {}),
  };
  const assignSpan = (old: readonly PMNode[], written: readonly PMNode[]) => {
    const result = assignLinkRefs({ ...common, old: walkLinkOccurrences(old), written });
    minted.push(...result.minted);
    return result.nodes;
  };
  return {
    minted,
    assignSpan,
    assignSplice(splice) {
      const restored = restoreOutsideSplice({
        ...splice,
        assignOccurrences(old, written) {
          const result = assignOccurrences({ ...common, old, written });
          minted.push(...result.minted);
          return result.attrs;
        },
      });
      if ("nodes" in restored) return restored.nodes;
      input.onSpliceFallback?.(restored.fallback);
      return assignSpan(splice.oldGroup, splice.parsed.blocks);
    },
  };
}
