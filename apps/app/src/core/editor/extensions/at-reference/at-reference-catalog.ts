/**
 * What `@` may offer, and what it refuses to ask about.
 *
 * The rows and the ranking are [`@/core/references`](../../../references/index.ts) —
 * one implementation, so this menu and `[[` and the composer can never disagree
 * about which document a query means. What lives here is the two facts that are
 * `@`'s own: the scope it asks with (documents AND assets, where `[[` asks for
 * documents alone) and the one query shape that is not a name at all.
 *
 * The host owns the catalog because the copy in it is localized — the listbox's
 * name and the headings the kinds group under.
 */

import {
  filterReferenceItems,
  type ReferenceCandidate,
  type ReferenceCatalog,
  type ReferenceItemOf,
  type ReferenceKind,
} from "@/core/references";

/** `@` brings an existing thing here: a page to link, or a picture to place. */
const AT_REFERENCE_SCOPE = ["document", "asset"] as const;

/** A row `@` can offer: a document, an asset, or the page nobody has written yet. */
export type AtReferenceItem = ReferenceItemOf<(typeof AT_REFERENCE_SCOPE)[number]>;

/** What the menu needs that a row does not carry: the heading each kind sits under. */
export type AtReferenceMeta = { groupLabels: Record<ReferenceKind, string> };

export type AtReferenceCatalog = ReferenceCatalog & AtReferenceMeta;

/**
 * A query that opens with a space is not a name.
 *
 * `@` names a thing, and the name starts where the `@` ends — every writer who
 * has used one of these menus types them together. So "meet @ noon" and "@ 4pm,
 * the west gate" leave the writer alone with their own sentence, which is the
 * half of the word-boundary promise the boundary itself cannot keep: the space
 * before that `@` is exactly what makes it a legal trigger position.
 *
 * The `[[` lane's own refusal — a query carrying `]` or `|` — has no meaning
 * here. `@` opens no brackets, so there is nothing for a writer to close.
 */
const NOT_A_NAME = /^\s/u;

/**
 * A picture, or a page. Not the PDF beside them.
 *
 * The catalog carries every asset the project holds, because the composer's `@`
 * will name any of them as text. In prose there is nothing to insert for a PDF:
 * the one asset object this document format has is the inline image, and a row
 * that lands nothing is worse than a row that was never offered.
 */
function placeableInProse(candidate: ReferenceCandidate): boolean {
  return candidate.kind !== "asset" || candidate.fileType === "image";
}

export function atReferenceItems(
  catalog: AtReferenceCatalog,
  query: string,
): readonly AtReferenceItem[] {
  if (NOT_A_NAME.test(query)) return [];
  return filterReferenceItems(
    catalog.candidates.filter(placeableInProse),
    AT_REFERENCE_SCOPE,
    query,
  );
}
