/** Cross-process destination lock spans creation commit and best-effort notes inheritance. */
import { setTimeout } from "node:timers/promises";
import type { Database } from "@meridian/database";
import { createDrizzleSessionLock } from "../../../shared/drizzle-session-lock.js";
import type { DerivationLock } from "../ports/derivation-lock.js";

export function createDrizzleDerivationLock(db: Database): DerivationLock {
  const lock = createDrizzleSessionLock(db, 84n);
  return {
    async withDestination(threadId, operation) {
      let claim = await lock.tryAcquire(threadId);
      while (!claim) {
        await setTimeout(25);
        claim = await lock.tryAcquire(threadId);
      }
      const controller = new AbortController();
      const removeLost = claim.onLost(() => controller.abort(new Error("Derivation lock lost")));
      try {
        return await operation(controller.signal);
      } finally {
        removeLost();
        await claim.release();
      }
    },
  };
}
