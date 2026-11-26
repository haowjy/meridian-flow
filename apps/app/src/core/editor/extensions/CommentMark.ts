import { documentMarks } from "@meridian/prosemirror-schema";
import { Mark } from "@tiptap/core";
import type { MarkSpec } from "@tiptap/pm/model";

const spec = documentMarks.comment as MarkSpec;

export const CommentMark = Mark.create({
  name: "comment",
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
