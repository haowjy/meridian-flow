/** PostgreSQL advisory-lock adapter for independent handoff brief attempts. */
import type { Database } from "@meridian/database";
import { createDrizzleSessionLock } from "./drizzle-session-lock.js";
import type { HandoffBriefClaim } from "../ports/handoff-brief-claim.js";

export function createDrizzleHandoffBriefClaim(db: Database): HandoffBriefClaim {
  const lock = createDrizzleSessionLock(db, 83n);
  return {
    tryAcquire: (seedTurnId) => lock.tryAcquire(`meridian:handoff-brief:${seedTurnId}`),
  };
}
