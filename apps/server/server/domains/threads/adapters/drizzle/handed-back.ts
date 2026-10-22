/**
 * The conversation predicate for raw SQL readers. A turn leaves the conversation two ways and keeps its row
 * and blocks for diagnostics both times:
 *
 * - **Handed back:** a writer message that a hand-back took out of the chat. Its inbox row (same id as the
 *   turn) records the request that took it.
 * - **Forgotten:** a failed attempt, or the writer messages it drew nothing for, that the writer retried or
 *   the chat moved past (`turns.forgotten_by_turn_id`, write-once).
 *
 * Every SQL reader of conversation content or counts adds it to its turn id column. The graph (`graph` in
 * turn-repository.ts) is the only reader that does not.
 */
import { sql } from "drizzle-orm";

/**
 * `turnAlias` is the SQL alias of the `turns` row in hand, such as `t`, `candidate` or `turns`: both facts
 * are read from that row (the hand-back by its id, the stamp from its own column), so no extra scan is needed.
 * `throughPosition` bounds the span being read: a stamp counts only when the forgetting turn sits at or before
 * it, so a fork keeps what its source forgot after the cutoff. Omit it (null) for a local read, where every
 * stamp applies.
 */
export function inConversationSql(turnAlias: string, throughPosition: number | null = null) {
  const alias = sql.raw(turnAlias);
  const notForgotten =
    throughPosition === null
      ? sql`${alias}.forgotten_by_turn_id IS NULL`
      : // A scalar lookup, not NOT EXISTS: the planner would hash that into a scan of the whole `turns` table.
        sql`COALESCE((
          SELECT forgetter.position FROM turns forgetter WHERE forgetter.id = ${alias}.forgotten_by_turn_id
        ), 2147483647) > ${throughPosition}`;
  return sql`(${notHandedBackSql(`${turnAlias}.id`)} AND ${notForgotten})`;
}

/** Just the hand-back half: for readers of identity, such as `findById`, that keep a forgotten turn. */
export function notHandedBackSql(turnIdColumn: string) {
  const column = sql.raw(turnIdColumn);
  return sql`NOT EXISTS (
    SELECT 1 FROM thread_inbox_messages handed_back
    WHERE handed_back.id = ${column} AND handed_back.handed_back_by IS NOT NULL
  )`;
}
