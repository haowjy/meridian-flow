import type { Block } from "@meridian/contracts/protocol";

export function isToolDeliveryBlock(block: Block): boolean {
  return block.blockType === "tool_use" || block.blockType === "tool_result";
}
