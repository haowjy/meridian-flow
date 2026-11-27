import type { Node as PMNode } from "@tiptap/pm/model";

import { PROSE_TRIGGER_BLOCKS } from "../suggestion";

/**
 * `from` is the position of the `/` itself, which is what
 * `@tiptap/suggestion` hands its `allow` predicate as `range.from`.
 */
export function allowsSlashTrigger(doc: PMNode, from: number): boolean {
  if (from < 0 || from > doc.content.size) return false;

  const $from = doc.resolve(from);
  const block = $from.parent;

  if (block.type.spec.code) return false;
  if (!block.isTextblock || !PROSE_TRIGGER_BLOCKS.has(block.type.name)) return false;

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
