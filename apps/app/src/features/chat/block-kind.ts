/**
 * block-kind — image and helper-result sniffing for protocol `Block` values on
 * the assistant turn surface. Text and tool rendering use block types directly
 * in delivery helpers.
 */
import { type Block, blockContentRecord } from "@meridian/contracts/protocol";

import { type ImageBlockContent, parseImageBlockContent } from "@/rich-content/ImageBlock";

export function isImageBlock(block: Block): boolean {
  if (block.blockType === "image") return true;
  if (block.blockType !== "tool_result") return false;
  if (!block.content || typeof block.content !== "object") return false;
  const content = block.content as Record<string, unknown>;
  if (content.toolName !== "show_demo_image") return false;
  return parseImageBlockContent(content) !== null;
}

/** Writer-facing spawn card: a custom helper-result block, like ask_user's interrupt card. */
export function isHelperResultBlock(block: Block): boolean {
  return block.blockType === "custom" && blockContentRecord(block).kind === "helper-result";
}

/** The child's returned report, rendered as an `ArtifactCard` in the child transcript. */
export function isChildReportBlock(block: Block): boolean {
  return block.blockType === "custom" && blockContentRecord(block).kind === "child-report";
}

export function isToolDeliveryBlock(block: Block): boolean {
  return block.blockType === "tool_use" || block.blockType === "tool_result";
}

export function imageContentForBlock(block: Block): ImageBlockContent | null {
  if (block.blockType === "image") {
    return parseImageBlockContent(block.content);
  }
  return parseImageBlockContent(block.content);
}
