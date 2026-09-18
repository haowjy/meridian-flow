/**
 * tool-kind — the two kinds of assistant activity on the turn surface.
 *
 * An **artifact** is writer-facing and stays visible: a custom card (`ask_user`
 * interrupt, spawn report, child Return) or an image. A **process** item is
 * scaffolding — reasoning, reads, searches, shell, context — and belongs inside
 * the collapsed Thinking disclosure. The kind comes from the surface a block
 * produces, never from a tool-name list, so a new tool needs no edit here.
 */
import type { Block } from "@meridian/contracts/protocol";

import { isImageBlock } from "./block-kind";

export type ToolKind = "artifact" | "process";

export function toolKindForBlock(block: Block): ToolKind {
  if (block.blockType === "custom") return "artifact";
  if (isImageBlock(block)) return "artifact";
  return "process";
}

/** An artifact's result is a writer-facing surface; it never folds. */
export function isArtifactBlock(block: Block): boolean {
  return toolKindForBlock(block) === "artifact";
}
