/**
 * The conversation predicate for raw SQL readers. A writer message that a hand-back took out of the
 * chat keeps its turn and blocks for diagnostics, and its inbox row (same id as the turn) records the
 * request that took it. This predicate lives in the adapters: every SQL reader of conversation content
 * or counts adds it to its turn id column. The graph (`graph` in turn-repository.ts) is the only reader
 * that does not.
 */
import { sql } from "drizzle-orm";

/** `turnIdColumn` is the raw SQL reference to a turn id, such as `candidate.id` or `turn_blocks.turn_id`. */
export function notHandedBackSql(turnIdColumn: string) {
  const column = sql.raw(turnIdColumn);
  return sql`NOT EXISTS (
    SELECT 1 FROM thread_inbox_messages handed_back
    WHERE handed_back.id = ${column} AND handed_back.handed_back_by IS NOT NULL
  )`;
}
