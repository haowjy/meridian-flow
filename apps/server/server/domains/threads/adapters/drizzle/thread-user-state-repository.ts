/** One-statement desired-state persistence and effective-attention projection. */
import type { HomeChatAttention } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { ThreadUserStateRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";
import { effectiveAttentionSql, visibleConversationalTurnSql } from "./visible-conversation-sql.js";

type StateRow = {
  thread_id: string;
  is_favorite: boolean;
  manually_unread: boolean;
  last_opened_at: Date | string | null;
  attention: HomeChatAttention;
};

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Read effective attention without materializing a thread projection. */
async function readEffectiveAttention(
  db: DrizzleDatabase,
  threadId: string,
  userId: string,
): Promise<HomeChatAttention> {
  const rows = await currentDrizzleDb(db).execute(sql`
    WITH RECURSIVE lineage AS (
      SELECT tr.id, tr.parent_turn_id, tr.role, tr.status, tr.metadata,
        tr.created_at, tr.completed_at, 0 AS depth, ARRAY[tr.id]::uuid[] AS path
      FROM threads t JOIN turns tr ON tr.id = t.active_leaf_turn_id
      WHERE t.id = ${threadId}::uuid
      UNION ALL
      SELECT p.id, p.parent_turn_id, p.role, p.status, p.metadata,
        p.created_at, p.completed_at, l.depth + 1, l.path || p.id
      FROM lineage l JOIN turns p ON p.id = l.parent_turn_id
      WHERE NOT p.id = ANY(l.path)
    ), head AS (
      SELECT * FROM lineage l WHERE ${visibleConversationalTurnSql({
        role: sql`l.role`,
        metadata: sql`l.metadata`,
        turnId: sql`l.id`,
      })}
      ORDER BY depth LIMIT 1
    )
    SELECT ${effectiveAttentionSql({
      threadStatus: sql`t.status`,
      headRole: sql`h.role`,
      headStatus: sql`h.status`,
      headActivityAt: sql`COALESCE(h.completed_at, h.created_at)`,
      manuallyUnread: sql`s.manually_unread`,
      lastOpenedAt: sql`s.last_opened_at`,
    })} AS attention
    FROM threads t LEFT JOIN head h ON true
    LEFT JOIN thread_user_state s ON s.thread_id = t.id AND s.user_id = ${userId}::uuid
    WHERE t.id = ${threadId}::uuid
  `);
  return (
    Array.from(rows as unknown as Iterable<{ attention: HomeChatAttention }>)[0]?.attention ??
    "none"
  );
}

export function createDrizzleThreadUserStateRepository(
  db: DrizzleDatabase,
): ThreadUserStateRepository {
  return {
    async get(threadId, userId) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(schema.threadUserState)
        .where(
          and(
            eq(schema.threadUserState.threadId, threadId),
            eq(schema.threadUserState.userId, userId),
          ),
        );
      return {
        isFavorite: row?.isFavorite ?? false,
        manuallyUnread: row?.manuallyUnread ?? false,
        lastOpenedAt: row?.lastOpenedAt?.toISOString() ?? null,
      };
    },
    effectiveAttention(threadId, userId) {
      return readEffectiveAttention(db, threadId, userId);
    },
    async update(input) {
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH RECURSIVE mutation AS (
          INSERT INTO thread_user_state (
            thread_id, user_id, is_favorite, manually_unread, last_opened_at
          ) VALUES (
            ${input.threadId}::uuid,
            ${input.userId}::uuid,
            COALESCE(${input.isFavorite ?? null}::boolean, false),
            COALESCE(${input.isUnread ?? null}::boolean, false),
            CASE WHEN ${input.isUnread ?? null}::boolean = false THEN clock_timestamp() ELSE NULL END
          )
          ON CONFLICT (thread_id, user_id) DO UPDATE SET
            is_favorite = COALESCE(${input.isFavorite ?? null}::boolean, thread_user_state.is_favorite),
            manually_unread = COALESCE(${input.isUnread ?? null}::boolean, thread_user_state.manually_unread),
            last_opened_at = CASE
              WHEN ${input.isUnread ?? null}::boolean = false THEN
                GREATEST(COALESCE(thread_user_state.last_opened_at, '-infinity'::timestamptz), clock_timestamp())
              ELSE thread_user_state.last_opened_at
            END
          RETURNING thread_id, is_favorite, manually_unread, last_opened_at
        ), lineage AS (
          SELECT tr.id, tr.parent_turn_id, tr.role, tr.status, tr.metadata,
            tr.created_at, tr.completed_at, 0 AS depth, ARRAY[tr.id]::uuid[] AS path
          FROM threads t JOIN turns tr ON tr.id = t.active_leaf_turn_id
          WHERE t.id = ${input.threadId}::uuid
          UNION ALL
          SELECT p.id, p.parent_turn_id, p.role, p.status, p.metadata,
            p.created_at, p.completed_at, l.depth + 1, l.path || p.id
          FROM lineage l JOIN turns p ON p.id = l.parent_turn_id
          WHERE NOT p.id = ANY(l.path)
        ), head AS (
          SELECT * FROM lineage l WHERE ${visibleConversationalTurnSql({
            role: sql`l.role`,
            metadata: sql`l.metadata`,
            turnId: sql`l.id`,
          })}
          ORDER BY depth LIMIT 1
        )
        SELECT m.*, ${effectiveAttentionSql({
          threadStatus: sql`t.status`,
          headRole: sql`h.role`,
          headStatus: sql`h.status`,
          headActivityAt: sql`COALESCE(h.completed_at, h.created_at)`,
          manuallyUnread: sql`m.manually_unread`,
          lastOpenedAt: sql`m.last_opened_at`,
        })} AS attention
        FROM mutation m JOIN threads t ON t.id = m.thread_id LEFT JOIN head h ON true
      `);
      const row = Array.from(rows as unknown as Iterable<StateRow>)[0];
      if (!row) throw new Error(`Failed to update thread user state: ${input.threadId}`);
      return {
        threadId: row.thread_id,
        isFavorite: row.is_favorite,
        manuallyUnread: row.manually_unread,
        lastOpenedAt: timestamp(row.last_opened_at),
        attention: row.attention,
      };
    },
  };
}
