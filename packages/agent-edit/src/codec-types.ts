// Agent-edit local codec-adjacent types.
import type { PMNode } from "@meridian/markup";

/** Character offsets within a block's plain text for find/match and Tier 1 edits. */
export interface Span {
  from: number;
  to: number;
}

/** Top-level block unit passed through agent-edit model and resolver flows. */
export type Block = PMNode;
