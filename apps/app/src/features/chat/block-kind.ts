/**
 * block-kind — image and spawn sniffing for protocol `Block` values on the
 * assistant turn surface. Text and tool rendering use block types directly in
 * delivery helpers.
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

/**
 * A spawn is the writer's door to the child chat, so its tool blocks stay on
 * the settled frontier instead of folding into process history. Both halves
 * carry the tool name: the `tool_use` from the model, the persisted
 * `tool_result` from the spawn dispatch.
 */
export function isSpawnBlock(block: Block): boolean {
  if (block.blockType !== "tool_use" && block.blockType !== "tool_result") return false;
  return blockContentRecord(block).toolName === "spawn";
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
