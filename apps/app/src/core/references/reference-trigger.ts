/**
 * The `@` trigger for a host that has only a string and a caret.
 *
 * The editor's `@` rides `@tiptap/suggestion`, which owns detection, the range,
 * and the replace. A `<textarea>` has none of that, so the same three answers
 * live here as plain functions over text: where the token is, what a pick
 * spells, and what the string looks like afterwards. Nothing in this file
 * knows about a DOM node, a menu, or React — the host measures the caret and
 * renders; this decides.
 *
 * **A lone `@` is prose.** "meet @ noon" and `kael@example.com` are not
 * requests for a menu, so the trigger requires a word boundary before the `@`
 * where `[[` requires nothing: two brackets are already unambiguous
 * (§Trigger-composition 4). Spaces ARE allowed inside the query, because
 * document titles have spaces in them and a menu that stopped filtering at
 * "The Second" could never find "The Second Gate"; the cost is paid by the
 * empty-list-closes rule, which leaves a writer alone with their `@` as soon
 * as nothing matches.
 */

import { normalizeLinkHref } from "@/core/links";

import { MAX_REFERENCE_QUERY_LENGTH, type ReferenceItem } from "./reference-catalog";

/** A document row, without the create row a `document` scope also produces. */
export type ReferenceDocumentItem = Extract<ReferenceItem, { kind: "document" }>;

/** The live `@token` before the caret: where it starts, and what it is asking. */
export type ReferenceToken = {
  /** Position of the `@` itself. */
  from: number;
  /** The caret, which is where the query ends. */
  to: number;
  /** What the writer has typed after the `@`. Empty is a legitimate query. */
  query: string;
};

/** Text and where the caret sits in it, which is all a splice produces. */
export type ReferenceSplice = { text: string; caret: number };

/** Letters and digits, the same class the catalog's ranking calls a word. */
const WORD = /[\p{L}\p{N}]/u;

/**
 * The `@token` the caret is inside, or null when the writer is just writing.
 *
 * Scans back no further than a query the catalog would still answer: past that
 * the menu is closed anyway, and reading the whole message on every keystroke
 * to prove it would be work for nothing.
 */
export function findReferenceToken(text: string, caret: number): ReferenceToken | null {
  if (caret < 0 || caret > text.length) return null;

  const floor = Math.max(0, caret - MAX_REFERENCE_QUERY_LENGTH - 1);
  for (let index = caret - 1; index >= floor; index -= 1) {
    const character = text[index];
    // The trigger dies at the end of the line it opened on: a query that ran
    // across a newline is a writer who moved on, not a name.
    if (character === "\n" || character === "\r") return null;
    if (character !== "@") continue;
    // The nearest `@` wins, and it only opens a menu on a word boundary.
    const before = index > 0 ? (text[index - 1] ?? "") : "";
    if (index > 0 && WORD.test(before)) return null;
    return { from: index, to: caret, query: text.slice(index + 1, caret) };
  }
  return null;
}

/**
 * The one policy for what a picked document links as, whichever host asks.
 *
 * `[[Title]]` normally: it reads as prose, the dialect card already teaches
 * it, and the transcript renders it as a link. The canonical URI is the escape
 * hatch for the one case a title cannot carry — another document answers to
 * the same name, so the resolver would refuse both — and for a title the wire
 * format cannot spell back at all. A URI pick keeps the title as what the
 * writer reads; a host that can only splice a string drops the label and
 * spells the URI alone.
 *
 * This lives here rather than in either host so the editor's `@` and the
 * composer's `@` cannot drift: one catalog row, one answer.
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

/**
 * The message with the token replaced, and where the caret lands.
 *
 * A trailing space rides along unless the writer already has one there: every
 * mention surface a writer arrives from adds it, and the alternative is a
 * caret pressed against a `]]` that the next word would run into.
 */
export function spliceReference(
  text: string,
  token: ReferenceToken,
  spelling: string,
): ReferenceSplice {
  const after = text.slice(token.to);
  const spaced = /^\s/.test(after) ? spelling : `${spelling} `;
  return {
    text: `${text.slice(0, token.from)}${spaced}${after}`,
    caret: token.from + spaced.length,
  };
}
