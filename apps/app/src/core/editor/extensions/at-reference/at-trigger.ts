import type { Node as PMNode } from "@tiptap/pm/model";
import { PROSE_TRIGGER_BLOCKS } from "../suggestion";
export function allowsAtTrigger(doc: PMNode, from: number): boolean {
  if (from < 0 || from > doc.content.size) return false;
  const $from = doc.resolve(from);
  const block = $from.parent;
  if (block.type.spec.code || !block.isTextblock || !PROSE_TRIGGER_BLOCKS.has(block.type.name))
    return false;
  const before = $from.nodeBefore;
  const after = $from.nodeAfter;
  const beforeHref = before?.marks.find((mark) => mark.type.name === "link")?.attrs.href;
  const afterHref = after?.marks.find((mark) => mark.type.name === "link")?.attrs.href;
  if (beforeHref && beforeHref === afterHref) return false;
  if ($from.parentOffset === 0) return true;
  if (!before) return false;
  if (before.isText) return /\s$/u.test(before.text ?? "");
  return before.type.name === "hard_break";
}
