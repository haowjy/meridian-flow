/**
 * ContentBlock -> composer doc state
 *
 * Converts canonical ContentBlock[] into:
 * - plain text for the editor doc
 * - inline reference positions for ORC widget decorations
 *
 * Important: this preserves text exactly as authored.
 * We do not inject extra spaces while rebuilding from blocks.
 */

import type { ContentBlock } from "@/features/threads/types";
import type { ReferenceElementData } from "./inlineElements";

export interface ComposerDocState {
  plainText: string;
  elements: Array<{ position: number; data: ReferenceElementData }>;
}

export function contentBlocksToDocState(
  blocks: ContentBlock[],
): ComposerDocState {
  let plainText = "";
  const elements: ComposerDocState["elements"] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      plainText += block.text;
      continue;
    }

    elements.push({
      position: plainText.length,
      data: {
        type: "reference",
        documentId: block.documentId,
        refType: block.refType,
        displayName: block.displayName,
        documentPath: block.documentPath,
      },
    });
  }

  return { plainText, elements };
}
