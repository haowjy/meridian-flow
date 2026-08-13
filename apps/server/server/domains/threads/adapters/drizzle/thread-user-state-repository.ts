/** Atomic desired-state persistence for a writer's thread state. */
import type { HomeChatAttention } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import type { ThreadUserStateRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

async function readAttention(
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
      SELECT * FROM lineage l WHERE l.role = 'assistant'
        OR (l.role = 'user' AND NOT (COALESCE(l.metadata->>'kind', '') = 'system_update'
          AND COALESCE(l.metadata->>'section', '') = 'work_context'))
        OR (l.role = 'system' AND EXISTS (SELECT 1 FROM turn_blocks b
          WHERE b.turn_id = l.id AND b.block_type = 'custom'))
      ORDER BY depth LIMIT 1
    )
    SELECT CASE
      WHEN h.role = 'assistant' AND h.status = 'waiting_interrupt' THEN 'actionRequired'
      WHEN COALESCE(s.manually_unread, false) THEN 'unread'
      WHEN t.status = 'idle' AND h.role = 'assistant' AND h.status = 'complete'
        AND (s.last_opened_at IS NULL OR COALESCE(h.completed_at, h.created_at) > s.last_opened_at)
        THEN 'unread'
      ELSE 'none' END AS attention
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
      return readAttention(db, threadId, userId);
    },
    update(input) {
      return runInDrizzleTransaction(db, async () => {
        const current = await this.get(input.threadId, input.userId);
        const markingRead = input.isUnread === false;
        const now = new Date();
        const [row] = await currentDrizzleDb(db)
          .insert(schema.threadUserState)
          .values({
            threadId: input.threadId,
            userId: input.userId,
            isFavorite: input.isFavorite ?? current.isFavorite,
            manuallyUnread: input.isUnread ?? current.manuallyUnread,
            lastOpenedAt: markingRead
              ? now
              : current.lastOpenedAt
                ? new Date(current.lastOpenedAt)
                : null,
          })
          .onConflictDoUpdate({
            target: [schema.threadUserState.threadId, schema.threadUserState.userId],
            set: {
              ...(input.isFavorite === undefined ? {} : { isFavorite: input.isFavorite }),
              ...(input.isUnread === undefined
                ? {}
                : {
                    manuallyUnread: input.isUnread,
                    ...(markingRead
                      ? {
                          lastOpenedAt: sql`GREATEST(COALESCE(${schema.threadUserState.lastOpenedAt}, '-infinity'::timestamptz), clock_timestamp())`,
                        }
                      : {}),
                  }),
            },
          })
          .returning();
        if (!row) throw new Error(`Failed to update thread user state: ${input.threadId}`);
        return {
          threadId: input.threadId,
          isFavorite: row.isFavorite,
          manuallyUnread: row.manuallyUnread,
          lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
          attention: await readAttention(db, input.threadId, input.userId),
        };
      });
    },
  };
}
