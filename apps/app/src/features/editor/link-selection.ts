/** Resolve the link mark touching the current editor selection. */
import { type Editor, getMarkRange } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";

export type LinkSelection = {
  from: number;
  to: number;
  attributes: Record<string, unknown>;
  identity: Mark;
};

export function linkAtSelection(editor: Editor): LinkSelection | null {
  const { selection } = editor.state;
  const linkType = editor.schema.marks.link;
  if (!linkType) return null;
  if (!selection.empty && !editor.isActive("link")) return null;
  const range = getMarkRange(selection.$from, linkType);
  if (!range) return null;

  const mark = editor.state.doc
    .resolve(range.from)
    .nodeAfter?.marks.find((candidate) => candidate.type === linkType);
  return mark ? { from: range.from, to: range.to, attributes: mark.attrs, identity: mark } : null;
}

export function linkAttributesAtSelection(editor: Editor): Record<string, unknown> | null {
  return linkAtSelection(editor)?.attributes ?? null;
}
