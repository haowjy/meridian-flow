import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

import { createStandaloneEditorExtensions } from "../../config";

const schema = getSchema(createStandaloneEditorExtensions());

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const cell = (...content: JSONContent[]): JSONContent => ({ type: "table_cell", content });

export type TriggerEnvelopeRow = {
  claim: string;
  content: (marker: string) => JSONContent[];
  opens: boolean;
};

export const SHARED_TRIGGER_ENVELOPE: readonly TriggerEnvelopeRow[] = [
  {
    claim: "opens in a list item",
    opens: true,
    content: (marker) => [
      { type: "paragraph", attrs: { path: "-", marker: "item" }, content: [text(marker)] },
    ],
  },
  {
    claim: "opens in a quote paragraph",
    opens: true,
    content: (marker) => [
      { type: "paragraph", attrs: { path: ">" }, content: [text(`She wrote ${marker}`)] },
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
    content: (marker) => [{ type: "paragraph", attrs: { level: 2 }, content: [text(marker)] }],
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

export function positionsOutsideDocument(doc: PMNode): readonly number[] {
  return [-1, doc.content.size + 5];
}
