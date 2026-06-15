/**
 * optimistic-turn-id — shared identifier convention for client-only turns.
 *
 * The thread store creates temporary turns before the server returns canonical
 * IDs. Snapshot reconciliation uses this prefix as the explicit marker for
 * local-only turns that are allowed to survive a server snapshot.
 */

export const OPTIMISTIC_TURN_ID_PREFIX = "turn_local_";

export function isOptimisticTurnId(turnId: string): boolean {
  return turnId.startsWith(OPTIMISTIC_TURN_ID_PREFIX);
}
