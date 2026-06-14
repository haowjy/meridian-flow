/**
 * Purpose: Canonical TurnStatus type and the single terminal-status predicate.
 * Key decisions: This is a dependency-free leaf so both @meridian/contracts/threads and @meridian/contracts/protocol can re-export it without a runtime cycle through golden fixtures; terminal means durable final state and is the cross-boundary authority for whether a turn is still live, not the in-memory runner map.
 */

export type TurnStatus =
  | "pending"
  | "streaming"
  | "waiting_checkpoint"
  | "complete"
  | "cancelled"
  | "error";

/** Terminal = durable final state, no longer live. The single source of truth for turn liveness. */
export function isTerminalTurnStatus(status: TurnStatus): boolean {
  return status === "complete" || status === "cancelled" || status === "error";
}
