/**
 * Content Extraction
 *
 * Parses editor state into ordered ContentBlock[] preserving the interleaving
 * of text and @-references as typed by the user.
 *
 * Uses getInlineElementRanges() to find reference positions, then splits
 * the document text at each reference boundary.
 */

import type { EditorState } from "@codemirror/state";
import type { ContentBlock, DocumentReference } from "@/features/threads/types";
import { ORC, getInlineElementRanges } from "./inlineElements";

export interface ExtractedContent {
  /** Ordered content blocks preserving text/reference interleaving */
  blocks: ContentBlock[];
  /**
   * @deprecated Use blocks instead. Kept for backward compatibility during migration.
   * Clean text with \uFFFC stripped.
   */
  text: string;
  /**
   * @deprecated Use blocks instead. Kept for backward compatibility during migration.
   * Document references extracted from inline elements.
   */
  references: DocumentReference[];
}

/** Extract ordered content blocks from the editor state */
export function extractContent(state: EditorState): ExtractedContent {
  const docText = state.doc.toString();
  const ranges = getInlineElementRanges(state);
  const blocks: ContentBlock[] = [];

  let cursor = 0;
  for (const range of ranges) {
    // Text segment before this reference (strip \uFFFC chars)
    if (cursor < range.from) {
      const segment = docText.slice(cursor, range.from).replaceAll(ORC, "");
      if (segment.length > 0) {
        blocks.push({ type: "text", text: segment });
      }
    }

    // Reference block
    if (range.data.type === "reference") {
      blocks.push({
        type: "reference",
        documentId: range.data.documentId,
        refType: range.data.refType,
        displayName: range.data.displayName,
        documentPath: range.data.documentPath,
      });
    }

    // Move cursor past the reference's \uFFFC
    cursor = range.to;
  }

  // Trailing text after the last reference
  if (cursor < docText.length) {
    const segment = docText.slice(cursor).replaceAll(ORC, "");
    if (segment.length > 0) {
      blocks.push({ type: "text", text: segment });
    }
  }

  // Derive legacy fields from blocks for backward compatibility
  const text = blocks
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("");

  const references: DocumentReference[] = blocks
    .filter(
      (b): b is ContentBlock & { type: "reference" } => b.type === "reference",
    )
    .map((b) => ({ documentId: b.documentId, refType: b.refType }));

  return { blocks, text, references };
}
