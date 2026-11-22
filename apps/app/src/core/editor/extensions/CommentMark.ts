/**
 * A comment's anchor in the text, as the shared schema has it: the body lives outside the document,
 * and the binding stores the mark as the text style `comment_<id>`.
 */
import { documentMarks } from "@meridian/prosemirror-schema";
import { Mark } from "@tiptap/core";
import type { MarkSpec } from "@tiptap/pm/model";

const spec = documentMarks.comment as MarkSpec;

export const CommentMark = Mark.create({
  name: "comment",
  // As the shared schema has them: the binding keys a mark by `excludes`, then by its JSON.
  inclusive: spec.inclusive,
  excludes: spec.excludes,
  addAttributes: () => ({
    id: {
      default: null,
      rendered: false,
      parseHTML: (element: HTMLElement) => element.dataset.comment || null,
    },
  }),
  parseHTML: () => [{ tag: "span[data-comment]" }],
  renderHTML: ({ mark }) => [
    "span",
    { "data-comment": String(mark.attrs.id ?? ""), class: "meridian-comment" },
    0,
  ],
});
