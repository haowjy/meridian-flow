// keep: Never key by block.id (id spaces drift between sources); positional `${turnId}::${sequence}` keeps identity across the live-to-settled swap.
import type { Block } from "@meridian/contracts/protocol";

export function blockRenderKey(block: Block): string {
  const turnId = block.turnId || "live";
  return `${turnId}::${block.sequence}`;
}
