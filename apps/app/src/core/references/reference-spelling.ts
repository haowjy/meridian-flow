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

export function referenceSpelling(item: ReferenceDocumentItem): string {
  if (item.ambiguous) return item.uri;
  return normalizeLinkHref(`[[${item.name}]]`) ?? item.uri;
}
