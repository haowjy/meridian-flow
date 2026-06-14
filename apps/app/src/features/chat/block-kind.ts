// @ts-nocheck
/**
 * block-kind — image sniffing for protocol `Block` values on the assistant turn
 * surface. Text and tool rendering use block types directly in delivery helpers.
 */
import type { Block } from "@meridian/contracts/protocol";

import { type ImageBlockContent, parseImageBlockContent } from "@/rich-content/ImageBlock";

export function isImageBlock(block: Block): boolean {
  if (block.blockType === "image") return true;
  if (block.blockType !== "tool_result") return false;
  if (!block.content || typeof block.content !== "object") return false;
  const content = block.content as Record<string, unknown>;
  if (content.toolName !== "show_demo_image") return false;
  return parseImageBlockContent(content) !== null;
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
