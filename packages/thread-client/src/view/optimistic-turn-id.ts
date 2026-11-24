export const OPTIMISTIC_TURN_ID_PREFIX = "turn_local_";

export function isOptimisticTurnId(turnId: string): boolean {
  return turnId.startsWith(OPTIMISTIC_TURN_ID_PREFIX);
}
