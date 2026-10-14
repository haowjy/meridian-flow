/**
 * The conversation predicate for raw SQL readers. A writer message that a hand-back took out of the
 * chat keeps its turn and blocks for diagnostics, and its inbox row (same id as the turn) records the
 * request that took it. Every SQL reader of conversation content or counts adds this predicate to its
 * turn alias; the graph readers (positions, `prev_turn_id`, the leaf) do not.
 */
import { sql } from "drizzle-orm";

export function notHandedBackSql(turnAlias: string) {
  const alias = sql.raw(turnAlias);
  return sql`NOT EXISTS (
    SELECT 1 FROM thread_inbox_messages handed_back
    WHERE handed_back.id = ${alias}.id AND handed_back.handed_back_by IS NOT NULL
  )`;
}
