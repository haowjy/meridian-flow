/**
 * What a picked document is written as, wherever prose carries the reference
 * as a string — a wikilink insertion in the manuscript, a reference token's
 * wire spelling in the composer.
 *
 * `[[Title]]` normally: it reads as prose, the dialect card already teaches
 * it, and the transcript renders it as a link. The canonical URI is the escape
 * hatch for the one case a title cannot carry — another document answers to
 * the same name, so the resolver would refuse both — and for a title the
 * wire format cannot spell back at all.
 */

import { normalizeLinkHref } from "@/core/links";

import type { ReferenceItem } from "./reference-catalog";

/** A document row, without the create row a `document` scope also produces. */
export type ReferenceDocumentItem = Extract<ReferenceItem, { kind: "document" }>;

/**
 * The one policy for what a picked document links as, whichever host asks.
 *
 * A URI pick keeps the title as what the writer reads; a host that can only
 * splice a string drops the label and spells the URI alone. This lives here
 * rather than in either host so the editor's `@` and the composer's `@`
 * cannot drift: one catalog row, one answer.
 */
export type ReferenceLinkSpelling =
  | { kind: "wikilink"; name: string }
  | { kind: "uri"; text: string; uri: string };

export function referenceLinkSpelling(item: ReferenceDocumentItem): ReferenceLinkSpelling {
  if (!item.ambiguous) {
    const href = normalizeLinkHref(`[[${item.name}]]`);
    if (href) return { kind: "wikilink", name: href.slice(2, -2) };
  }
  return { kind: "uri", text: item.name, uri: item.uri };
}

/** The policy above, for a plain string: the wikilink's brackets or the bare URI. */
export function referenceSpelling(item: ReferenceDocumentItem): string {
  const spelling = referenceLinkSpelling(item);
  return spelling.kind === "wikilink" ? `[[${spelling.name}]]` : spelling.uri;
}
