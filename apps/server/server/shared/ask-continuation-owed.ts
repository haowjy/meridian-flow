// A NULL `continuation` (an old server's resolve) is owed like a pending one; reading it as nothing owed drops the writer's answer
import type { AskContinuationState, AskStatus } from "@meridian/contracts/threads";
import { asks } from "@meridian/database/schema";
import { type SQL, sql } from "drizzle-orm";

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
