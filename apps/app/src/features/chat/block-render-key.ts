import type { Block } from "@meridian/contracts/protocol";

export function blockRenderKey(block: Block): string {
  const turnId = block.turnId || "live";
  return `${turnId}::${block.sequence}`;
}
