/**
 * Purpose: Canonical TurnStatus type and the single terminal-status predicate.
 * Key decisions: This leaf shares the schema with snapshot decoding and the predicate with both clients; terminal means durable final state and is the cross-boundary authority for whether a turn is still live, not the in-memory runner map.
 */

import { z } from "zod";

export const turnStatusSchema = z.enum([
  "pending",
  "streaming",
  "waiting_interrupt",
  "complete",
  "cancelled",
  "error",
]);
export type TurnStatus = z.infer<typeof turnStatusSchema>;

/** Terminal = durable final state, no longer live. The single source of truth for turn liveness. */
export function isTerminalTurnStatus(status: TurnStatus): boolean {
  return status === "complete" || status === "cancelled" || status === "error";
}
