import type { Block } from "@meridian/contracts/protocol";

export function isArtifactBlock(block: Block): boolean {
  return block.blockType === "custom";
}
