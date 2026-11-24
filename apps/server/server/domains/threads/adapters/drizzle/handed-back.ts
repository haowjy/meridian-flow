import { sql } from "drizzle-orm";

export function inConversationSql(turnAlias: string, throughPosition: number | null = null) {
  const alias = sql.raw(turnAlias);
  const notForgotten =
    throughPosition === null
      ? sql`${alias}.forgotten_by_turn_id IS NULL`
      : sql`COALESCE((
          SELECT forgetter.position FROM turns forgetter WHERE forgetter.id = ${alias}.forgotten_by_turn_id
        ), 2147483647) > ${throughPosition}`;
  return sql`(${notHandedBackSql(`${turnAlias}.id`)} AND ${notForgotten})`;
}

export function notHandedBackSql(turnIdColumn: string) {
  const column = sql.raw(turnIdColumn);
  return sql`NOT EXISTS (
    SELECT 1 FROM thread_inbox_messages handed_back
    WHERE handed_back.id = ${column} AND handed_back.handed_back_by IS NOT NULL
  )`;
}
