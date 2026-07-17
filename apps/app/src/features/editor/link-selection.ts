/** Resolve the link mark touching the current editor selection. */
import { type Editor, getMarkRange } from "@tiptap/core";

export function linkAttributesAtSelection(editor: Editor): Record<string, unknown> | null {
  const { selection } = editor.state;
  if (!selection.empty) {
    return editor.isActive("link") ? editor.getAttributes("link") : null;
  }

  const linkType = editor.schema.marks.link;
  if (!linkType) return null;
  const range = getMarkRange(selection.$from, linkType);
  if (!range) return null;

  const mark = editor.state.doc
    .resolve(range.from)
    .nodeAfter?.marks.find((candidate) => candidate.type === linkType);
  return mark?.attrs ?? null;
}
