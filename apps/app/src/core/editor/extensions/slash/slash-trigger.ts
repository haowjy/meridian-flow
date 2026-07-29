/**
 * Where `/` opens the menu — the whole envelope, as one pure predicate.
 *
 * The old slash menu's failure (F6) was not a bad rule but an undefined one:
 * the trigger was gated on preconditions nobody had written down, so a writer
 * who typed `/` and got a literal slash had no way to learn why. This function
 * IS the contract (§5.7), and `slash-trigger.test.ts` is its truth table:
 *
 * - opens at the start of a text block, or immediately after whitespace
 * - in paragraphs (empty or not), headings, list items, quote paragraphs, and
 *   table cells, all of which are one of two node types once resolved
 * - never mid-word, never inside a code fence (which is also the diagram's
 *   source), and nowhere else is denied
 *
 * Everything the trigger needs is in the document, so nothing here reads the
 * editor, the catalog, or the view. A caller that wants "and the catalog is
 * live" composes that itself.
 */

import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Prose the writer types sentences into. A list item, a quote, and a table
 * cell all resolve to a paragraph, so the two names cover §5.7's five places.
 * Anything absent is denied: a `jsx_leaf`'s text is a component's props, not a
 * sentence, and an unlisted future block should stay silent until it is
 * deliberately let in.
 */
export const SLASH_TRIGGER_BLOCKS: ReadonlySet<string> = new Set(["paragraph", "heading"]);

/**
 * `from` is the position of the `/` itself, which is what
 * `@tiptap/suggestion` hands its `allow` predicate as `range.from`.
 */
export function allowsSlashTrigger(doc: PMNode, from: number): boolean {
  if (from < 0 || from > doc.content.size) return false;

  const $from = doc.resolve(from);
  const block = $from.parent;

  // A code fence is source, not prose — and a mermaid fence is the diagram's
  // source pane, so this one check closes both of §5.7's "never" cases.
  if (block.type.spec.code) return false;
  if (!block.isTextblock || !SLASH_TRIGGER_BLOCKS.has(block.type.name)) return false;

  // Block start: nothing to be in the middle of.
  if ($from.parentOffset === 0) return true;

  // Word boundary, read from the inline node the `/` was typed against rather
  // than from its text: an inline leaf has no text, and the two kinds differ.
  // A hard break starts a line, so `/` after one is at a start. An inline
  // image is a thing standing in the sentence, and typing `/` against it is no
  // more a boundary than typing it against a word.
  const before = $from.nodeBefore;
  if (!before) return false;
  if (before.isText) return /\s$/u.test(before.text ?? "");
  return before.type.name === "hard_break";
}
