/**
 * block-kind — tool-delivery sniffing for protocol `Block` values on
 * the assistant turn surface. Text and tool rendering use block types directly
 * in delivery helpers.
 */
import type { Block } from "@meridian/contracts/protocol";

export function isToolDeliveryBlock(block: Block): boolean {
  return block.blockType === "tool_use" || block.blockType === "tool_result";
}
