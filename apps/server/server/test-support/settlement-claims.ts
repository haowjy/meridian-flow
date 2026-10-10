/**
 * Settlement claim helpers shared by DB suites: a pending batch whose warm owner "died"
 * becomes claimable by recovery once its lease has expired.
 */
import type { Database } from "@meridian/database";
import { branchPushSettlementBatches } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../shared/drizzle-transaction.js";

/**
 * Expires the lease of every claimed pending batch, as if the database clock passed it.
 * Runs in the caller's transaction when there is one (completion and abandonment hold the
 * row there).
 */
export function expirePendingSettlementClaims(db: Database) {
  return currentDrizzleDb(db)
    .update(branchPushSettlementBatches)
    .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
    .where(
      and(
        eq(branchPushSettlementBatches.state, "pending"),
        sql`${branchPushSettlementBatches.claimToken} IS NOT NULL`,
      ),
    );
}

/** Brings every pending batch's retry backoff due now, as if its wait had passed. */
export function makePendingSettlementsDue(db: Database) {
  return currentDrizzleDb(db)
    .update(branchPushSettlementBatches)
    .set({ availableAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(branchPushSettlementBatches.state, "pending"));
}
