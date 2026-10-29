/**
 * When a resolved ask still owes a continuation turn. One rule for the SQL claim, the held-ask
 * locks and the in-memory adapter, so the copies cannot drift.
 *
 * Rollout tolerance: a server from before migration 0108 resolves an ask (`answered` or
 * `expired`) without writing `continuation`, so its row stays NULL after 0108's backfill has run.
 * That row is owed exactly like a `pending` one; reading NULL as "nothing owed" would drop the
 * writer's answer. A cancelled ask is never owed. A NULL row the old server already continued also
 * reads as owed, since nothing marks it done: that costs one extra locked row, and a later Stop
 * marks it `cancelled` with an `ask.updated` that changes nothing visible. The follow-up contract migration re-runs the
 * backfill and then deletes the NULL branch here.
 *
 * The `asks_held_by_thread` index covers only `continuation = 'pending'`, so this wider predicate
 * can miss it and scan; that costs little while the rollout runs and ends with the follow-up.
 */
import type { AskContinuationState, AskStatus } from "@meridian/contracts/threads";
import { asks } from "@meridian/database/schema";
import { type SQL, sql } from "drizzle-orm";

/** The predicate over the `asks` table, or over an alias of it (`sql\`a\``). */
export function continuationOwedSql(table: SQL = sql`${asks}`): SQL {
  return sql`(${table}.continuation = 'pending'
    OR (${table}.continuation IS NULL AND ${table}.status IN ('answered', 'expired')))`;
}

export function isContinuationOwed(ask: {
  continuation: AskContinuationState | null;
  status: AskStatus;
}): boolean {
  return (
    ask.continuation === "pending" ||
    (ask.continuation === null && (ask.status === "answered" || ask.status === "expired"))
  );
}
