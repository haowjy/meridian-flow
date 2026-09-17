/**
 * Where `/` opens the composer command menu.
 *
 * Word-boundary like manuscript slash, but this predicate is for the composer
 * StarterKit schema (`hardBreak`), not manuscript insertion.
 */

import type { Node as PMNode } from "@tiptap/pm/model";

import { PROSE_TRIGGER_BLOCKS } from "@/core/editor/extensions/suggestion";

export function allowsComposerCommandTrigger(doc: PMNode, from: number): boolean {
  if (from < 0 || from > doc.content.size) return false;

  const $from = doc.resolve(from);
  const block = $from.parent;

  if (block.type.spec.code) return false;
  if (!block.isTextblock || !PROSE_TRIGGER_BLOCKS.has(block.type.name)) return false;
  if ($from.parentOffset === 0) return true;

  const before = $from.nodeBefore;
  if (!before) return false;
  if (before.isText) return /\s$/u.test(before.text ?? "");
  return before.type.name === "hardBreak" || before.type.name === "hard_break";
}
