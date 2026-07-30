/**
 * The envelope both suggestion triggers share, as rows.
 *
 * `/` and `[[` differ in their boundary rules — one needs a word boundary, the
 * other refuses an existing link — but the places a trigger may open at all are
 * one decision, held in `PROSE_TRIGGER_BLOCKS` and read by both predicates. So
 * the containers and the source refusals are one corpus, consumed by both lane
 * suites, and a block that becomes prose (or stops being it) is one row here
 * rather than two edits in two files.
 *
 * Lane-specific rules stay in the lane's own suite: this corpus says where a
 * trigger may open, never what a trigger is.
 */

import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

import { createStandaloneEditorExtensions } from "../../config";

const schema = getSchema(createStandaloneEditorExtensions());

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const cell = (...content: JSONContent[]): JSONContent => ({ type: "table_cell", content });

export type TriggerEnvelopeRow = {
  /** What the row proves, in the writer's terms. */
  claim: string;
  /** The document, with `marker` typed where the writer typed it. */
  content: (marker: string) => JSONContent[];
  opens: boolean;
};

export const SHARED_TRIGGER_ENVELOPE: readonly TriggerEnvelopeRow[] = [
  {
    claim: "opens in a list item",
    opens: true,
    content: (marker) => [
      {
        type: "bullet_list",
        content: [{ type: "list_item", content: [paragraph(text(marker))] }],
      },
    ],
  },
  {
    claim: "opens in a quote paragraph",
    opens: true,
    content: (marker) => [
      { type: "blockquote", content: [paragraph(text(`She wrote ${marker}`))] },
    ],
  },
  {
    claim: "opens in a table cell",
    opens: true,
    content: (marker) => [
      {
        type: "table",
        content: [
          {
            type: "table_row",
            content: [cell(paragraph(text(marker))), cell(paragraph()), cell(paragraph())],
          },
        ],
      },
    ],
  },
  {
    claim: "opens in a heading",
    opens: true,
    content: (marker) => [{ type: "heading", attrs: { level: 2 }, content: [text(marker)] }],
  },
  {
    claim: "never opens inside a code fence, which is source rather than prose",
    opens: false,
    content: (marker) => [{ type: "code_block", content: [text(marker)] }],
  },
  {
    claim: "never opens inside a diagram's fence, which is that diagram's source pane",
    opens: false,
    content: (marker) => [
      { type: "code_block", attrs: { language: "mermaid" }, content: [text(marker)] },
    ],
  },
  {
    claim: "never opens inside a registered component",
    opens: false,
    content: (marker) => [{ type: "jsx_leaf", attrs: { name: "Stat" }, content: [text(marker)] }],
  },
];

/**
 * Build a document and return it with the position of the marker a writer just
 * typed, which is what `@tiptap/suggestion` hands its `allow` predicate as
 * `range.from`.
 */
export function docWithTrigger(
  content: JSONContent[],
  marker: string,
): { doc: PMNode; from: number } {
  const doc = schema.nodeFromJSON({ type: "doc", content });
  let from: number | null = null;
  doc.descendants((node, pos) => {
    if (from !== null) return false;
    if (!node.isText) return true;
    const index = node.text?.indexOf(marker) ?? -1;
    if (index >= 0) from = pos + index;
    return true;
  });
  if (from === null) throw new Error(`fixture has no ${marker}`);
  return { doc, from };
}

/** Positions no document holds, where a trigger predicate must refuse. */
export function positionsOutsideDocument(doc: PMNode): readonly number[] {
  return [-1, doc.content.size + 5];
}
