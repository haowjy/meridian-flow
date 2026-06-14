// @ts-nocheck
/**
 * block-render-key — single source of truth for React keys on assistant
 * blocks. Keys are positional `${turnId}::${sequence}` so the SAME identity
 * survives the live→settled swap (the persisted block carries the same
 * `(turnId, sequence)` it had while streaming). Never key by `block.id` — id
 * spaces can drift between sources; positional identity cannot.
 */
import type { Block } from "@meridian/contracts/protocol";

export function blockRenderKey(block: Block): string {
  // `turnId` may be the empty string on synthesized live frontiers before the
  // first event sets the turn id; fall back to id in that pre-turn window.
  const turnId = block.turnId || "live";
  return `${turnId}::${block.sequence}`;
}
