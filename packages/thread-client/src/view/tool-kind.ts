/**
 * tool-kind — the two kinds of assistant activity on the turn surface.
 *
 * An **artifact** is writer-facing and stays visible: a custom card (`ask_user`
 * interrupt, spawn report, child Return), an image, or a file. A **process**
 * item is scaffolding — reasoning, reads, searches, shell, context — and belongs
 * inside the collapsed Thinking disclosure. The kind comes from the surface a
 * block produces, never from a tool-name list, so a new tool needs no edit here.
 *
 * This is the single classifier: `partition-turn.ts` calls `isArtifactBlock`
 * rather than re-deriving the split.
 */
import type { Block } from "@meridian/contracts/protocol";

import { isImageBlock } from "./block-kind";

export function isArtifactBlock(block: Block): boolean {
  if (block.blockType === "custom" || block.blockType === "image" || block.blockType === "file") {
    return true;
  }
  return isImageBlock(block);
}
