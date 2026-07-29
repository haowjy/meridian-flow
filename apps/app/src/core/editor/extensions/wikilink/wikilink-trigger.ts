/**
 * Where `[[` opens the document menu — the whole envelope, as one predicate.
 *
 * Wikilinks are what an LLM emits and what a writer types, so the trigger has
 * to be readable in one place (§5.5, and the lesson §5.7 learned the hard
 * way). The rule:
 *
 * - anywhere in prose the writer is composing a sentence in: paragraphs,
 *   headings, list items, quote paragraphs, and table cells, all of which
 *   resolve to one of two node types
 * - never inside a code fence, which is source rather than prose, and is also
 *   the diagram's editing pane
 * - never inside an existing link, where `[[` is text the writer is correcting
 *   rather than a new link they are starting
 *
 * Unlike `/`, `[[` needs no word boundary: two brackets are already an
 * unambiguous request, and a wikilink legitimately follows an opening quote or
 * parenthesis with nothing between.
 */

import type { Node as PMNode } from "@tiptap/pm/model";

import { PROSE_TRIGGER_BLOCKS } from "../suggestion";

/**
 * `from` is the position of the first `[`, which is what `@tiptap/suggestion`
 * hands its `allow` predicate as `range.from`.
 */
export function allowsWikilinkTrigger(doc: PMNode, from: number): boolean {
  if (from < 0 || from > doc.content.size) return false;

  const $from = doc.resolve(from);
  const block = $from.parent;

  // A code fence is source, not prose — and a mermaid fence is the diagram's
  // source pane, so this one check closes both cases.
  if (block.type.spec.code) return false;
  if (!block.isTextblock || !PROSE_TRIGGER_BLOCKS.has(block.type.name)) return false;

  return !insideLink($from.nodeBefore, $from.nodeAfter);
}

/**
 * True only between two halves of the same link. The end of a link is not
 * inside it — the mark is non-inclusive, so what the writer types there is
 * plain prose and may perfectly well be a new wikilink.
 */
function insideLink(before: PMNode | null, after: PMNode | null): boolean {
  const opening = linkHref(before);
  return opening !== null && opening === linkHref(after);
}

function linkHref(node: PMNode | null): string | null {
  const mark = node?.marks.find((candidate) => candidate.type.name === "link");
  return mark ? String(mark.attrs.href ?? "") : null;
}
