/**
 * editor schema — the canonical ProseMirror document schema for the editor.
 *
 * Re-exports the shared `@meridian/prosemirror-schema` builder and declares the
 * authoritative node/mark name lists plus the Yjs fragment name. Single source
 * of the document shape shared by the editor and collaboration layers.
 */
import { buildDocumentSchema, documentMarks, documentNodes } from "@meridian/prosemirror-schema";

export const PROSEMIRROR_FRAGMENT_NAME = "prosemirror";

export const DOCUMENT_NODE_NAMES = [
  "doc",
  "paragraph",
  "heading",
  "code_block",
  "blockquote",
  "bullet_list",
  "ordered_list",
  "list_item",
  "table",
  "table_row",
  "table_cell",
  "table_header",
  "math_display",
  "image",
  "figure",
  "hard_break",
  "text",
] as const;

export const DOCUMENT_MARK_NAMES = ["strong", "em", "code", "link"] as const;

export type DocumentNodeName = (typeof DOCUMENT_NODE_NAMES)[number];
export type DocumentMarkName = (typeof DOCUMENT_MARK_NAMES)[number];
export type DocumentSchemaType = "document";

export { buildDocumentSchema, documentMarks, documentNodes };
