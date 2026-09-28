/** Single-process claim adapter for handoff brief tests and local composition. */
import type {
  HandoffBriefClaim,
  HandoffBriefClaimHandle,
} from "../../ports/handoff-brief-claim.js";

export function createInMemoryHandoffBriefClaim(): HandoffBriefClaim {
  const claims = new Set<string>();
  return {
    async tryAcquire(seedTurnId) {
      if (claims.has(seedTurnId)) return null;
      claims.add(seedTurnId);
      const listeners = new Set<() => void>();
      let released = false;
      return {
        onLost(listener) {
          if (released) listener();
          else listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async release() {
          if (released) return;
          released = true;
          claims.delete(seedTurnId);
          listeners.clear();
        },
      } satisfies HandoffBriefClaimHandle;
    },
  };
}
