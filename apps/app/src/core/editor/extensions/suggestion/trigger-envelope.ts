/**
 * Where a menu the writer types underneath may open — the rules every trigger
 * shares, as named predicates.
 *
 * `/`, `[[`, and `@` are three requests made in the same prose, and they differ
 * only in which of these rules they demand. What counts as prose is one
 * decision (a block that becomes a place to write sentences becomes one for all
 * three at once); so is what a word boundary is, and so is what it means to be
 * inside a link. Each lane's own predicate is then one expression over these,
 * readable in a single line, and the day a new block type arrives it is one
 * edit rather than three that drift.
 *
 * Everything here is a question about the document alone. A lane that also
 * needs "and the host is offering a catalog" composes that where the catalog
 * lives.
 */

import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * The blocks a typed-under menu may open in.
 *
 * Prose the writer types sentences into. A list item, a quote, and a table cell
 * all resolve to a paragraph, so these two names cover every place §5.5 and
 * §5.7 expect a trigger. Anything absent is denied: a `jsx_leaf`'s text is a
 * component's props, not a sentence, and an unlisted future block stays silent
 * until it is deliberately let in.
 */
const PROSE_TRIGGER_BLOCKS: ReadonlySet<string> = new Set(["paragraph", "heading"]);

/**
 * Is `from` in prose at all?
 *
 * A code fence is source rather than prose — and a mermaid fence is the
 * diagram's own source pane, so this one check closes both cases.
 */
export function inProseBlock(doc: PMNode, from: number): boolean {
  if (from < 0 || from > doc.content.size) return false;

  const block = doc.resolve(from).parent;
  if (block.type.spec.code) return false;
  return block.isTextblock && PROSE_TRIGGER_BLOCKS.has(block.type.name);
}

/**
 * Where a reference trigger — `[[` or `@` — may open.
 *
 * Prose, and not inside a link that is already there: typing inside a link's
 * text carries the link mark, so a writer doing it is correcting a
 * destination's label rather than starting a second link inside it. The end of
 * a link is not inside it (the mark is non-inclusive), so a reference typed
 * right after one is an ordinary sentence.
 *
 * `from` is the position of the trigger text itself, which is what
 * `@tiptap/suggestion` hands its `allow` predicate as `range.from`.
 */
export function allowsProseTrigger(doc: PMNode, from: number): boolean {
  if (!inProseBlock(doc, from)) return false;

  const $from = doc.resolve(from);
  return !insideLink($from.nodeBefore, $from.nodeAfter);
}

/**
 * Is `from` where a word starts?
 *
 * Read from the inline node the trigger was typed against rather than from its
 * text: an inline leaf has no text, and the two kinds differ. A hard break
 * starts a line, so a trigger after one is at a start. An inline image is a
 * thing standing in the sentence, and typing against it is no more a boundary
 * than typing against a word.
 *
 * Punctuation is not a boundary. `he said,/` and `map.@` are both still inside
 * a run the writer is typing, and a trigger that fired there would fire in the
 * middle of an ordinary word far more often than a writer ever asked it to.
 */
export function atWordBoundary(doc: PMNode, from: number): boolean {
  if (from < 0 || from > doc.content.size) return false;

  const $from = doc.resolve(from);
  // Block start: nothing to be in the middle of.
  if ($from.parentOffset === 0) return true;

  const before = $from.nodeBefore;
  if (!before) return false;
  if (before.isText) return /\s$/u.test(before.text ?? "");
  return before.type.name === "hard_break";
}

/**
 * True only between two halves of the same link.
 */
function insideLink(before: PMNode | null, after: PMNode | null): boolean {
  const opening = linkHref(before);
  return opening !== null && opening === linkHref(after);
}

function linkHref(node: PMNode | null): string | null {
  const mark = node?.marks.find((candidate) => candidate.type.name === "link");
  return mark ? String(mark.attrs.href ?? "") : null;
}
