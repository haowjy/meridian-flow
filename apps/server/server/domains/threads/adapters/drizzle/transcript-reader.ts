/** Indexed keyset reads for effective transcript spans. */

import type { Turn } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { SYSTEM_TURN_KINDS } from "../../domain/turn-metadata.js";
import type {
  ReadTranscriptItemsInput,
  TranscriptItemRow,
  TranscriptSpan,
  TurnRepository,
} from "../../ports/repositories.js";
import { mapBlock, mapTurn } from "./mappers.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

type ItemKey = { turn_id: string; position: number; sequence: number; block_id: string | null };

/** Exposed for plan verification; every branch is independently index-bounded. */
export function transcriptItemKeysSql(input: ReadTranscriptItemsInput) {
  const direction = input.order === "newest_first" ? sql`DESC` : sql`ASC`;
  const branches = input.spans.map((span) => {
    const positionConditions = [
      sql`t.thread_id = ${span.threadId}::uuid`,
      sql`t.position > ${span.afterPosition}`,
    ];
    if (span.throughPosition !== null)
      positionConditions.push(sql`t.position <= ${span.throughPosition}`);
    if (input.through) positionConditions.push(sql`t.position <= ${input.through.position}`);
    if (input.after) {
      const compare =
        input.order === "newest_first"
          ? input.unit === "item"
            ? sql`<=`
            : sql`<`
          : input.unit === "item"
            ? sql`>=`
            : sql`>`;
      positionConditions.push(sql`t.position ${compare} ${input.after.position}`);
    }
    if (input.unit === "turn") {
      return sql`(
        SELECT t.id AS turn_id, t.position, -1::int AS sequence, NULL::uuid AS block_id
        FROM turns t
        WHERE ${sql.join(positionConditions, sql` AND `)}
        ORDER BY t.position ${direction}
        LIMIT ${input.limit + 1}
      )`;
    }

    const throughBlockBound = input.through
      ? sql`AND b.sequence <= CASE WHEN t.position = ${input.through.position} THEN ${input.through.sequence} ELSE 2147483647 END`
      : sql``;
    const afterBlockBound = input.after
      ? sql`AND b.sequence ${input.order === "newest_first" ? sql`<` : sql`>`}
          CASE WHEN t.position = ${input.after.position} THEN ${input.after.sequence}
            ELSE ${input.order === "newest_first" ? sql`2147483647` : sql`-1`} END`
      : sql``;
    return sql`(
      SELECT t.id AS turn_id, t.position, b.sequence, b.id AS block_id
      FROM (
        SELECT t.id, t.thread_id, t.position
        FROM turns t
        WHERE ${sql.join(positionConditions, sql` AND `)}
        ORDER BY t.position ${direction}
        LIMIT ${input.limit + 2}
      ) t
      CROSS JOIN LATERAL (
        SELECT selected.id, selected.sequence
        FROM (
          SELECT b.id, b.sequence
          FROM turn_blocks b
          WHERE b.turn_id = t.id
            ${throughBlockBound}
            ${afterBlockBound}
          ORDER BY b.sequence ${direction}
          LIMIT ${input.limit + 1}
        ) selected
        UNION ALL
        SELECT NULL::uuid AS id, -1::int AS sequence
        WHERE NOT EXISTS (
          SELECT 1 FROM turn_blocks existing WHERE existing.turn_id = t.id
        )
      ) b
      WHERE ${input.through ? sql`(t.position < ${input.through.position} OR (t.position = ${input.through.position} AND b.sequence <= ${input.through.sequence}))` : sql`TRUE`}
        AND ${input.after ? sql`(t.position ${input.order === "newest_first" ? sql`<` : sql`>`} ${input.after.position} OR (t.position = ${input.after.position} AND b.sequence ${input.order === "newest_first" ? sql`<` : sql`>`} ${input.after.sequence}))` : sql`TRUE`}
    )`;
  });
  const union =
    branches.length > 0
      ? sql.join(branches, sql` UNION ALL `)
      : sql`SELECT NULL::uuid AS turn_id, 0::int AS position, -1::int AS sequence, NULL::uuid AS block_id WHERE FALSE`;
  return sql`
    WITH page_keys AS (${union})
    SELECT turn_id, position, sequence, block_id
    FROM page_keys
    ORDER BY position ${direction}, sequence ${direction}
    LIMIT ${input.limit + 1}
  `;
}

/** `isConversationTurn` in SQL; the two must stay the same rule. */
const conversationTurnSql = sql`(
  COALESCE(t.metadata->>'kind', '') NOT IN (${sql.join(
    SYSTEM_TURN_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  )})
  AND (
    (t.role = 'user' AND (t.origin = 'writer' OR (t.origin = 'system' AND t.metadata->>'kind' = 'inbox_message')))
    OR (t.role = 'assistant' AND t.origin = 'assistant')
  )
)`;

function conversationTurnBranches(spans: readonly TranscriptSpan[], beforePosition?: number) {
  return spans.map(
    (span) => sql`(
      SELECT t.id, t.position
      FROM turns t
      WHERE t.thread_id = ${span.threadId}::uuid
        AND t.position > ${span.afterPosition}
        ${span.throughPosition === null ? sql`` : sql`AND t.position <= ${span.throughPosition}`}
        ${beforePosition === undefined ? sql`` : sql`AND t.position < ${beforePosition}`}
        AND ${conversationTurnSql}
    )`,
  );
}

/** SQL shape used by the first-unsettled lookup and its partial index plan. */
export function transcriptUnsettledTurnsSql(spans: readonly TranscriptSpan[]) {
  const branches = spans.map(
    (span) => sql`(
      SELECT t.id, t.position
      FROM turns t
      WHERE t.thread_id = ${span.threadId}::uuid
        AND t.position > ${span.afterPosition}
        ${span.throughPosition === null ? sql`` : sql`AND t.position <= ${span.throughPosition}`}
        AND t.status IN ('pending','streaming','waiting_interrupt')
      ORDER BY t.position ASC
      LIMIT 1
    )`,
  );
  return sql`
    SELECT id FROM (${sql.join(branches, sql` UNION ALL `)}) unsettled
    ORDER BY position ASC LIMIT 1
  `;
}

/** SQL shape used by prompt-epoch boundary reads and their partial index. */
export function transcriptBoundariesSql(spans: readonly TranscriptSpan[]) {
  const branches = spans.map(
    (span) => sql`(
      SELECT t.id, t.position
      FROM turns t
      WHERE t.thread_id = ${span.threadId}::uuid
        AND t.position > ${span.afterPosition}
        ${span.throughPosition === null ? sql`` : sql`AND t.position <= ${span.throughPosition}`}
        AND t.prompt_bake_id IS NOT NULL AND t.status = 'complete'
      ORDER BY t.position ASC
    )`,
  );
  return sql`SELECT id FROM (${sql.join(branches, sql` UNION ALL `)}) boundaries ORDER BY position ASC`;
}

export function createDrizzleTranscriptReader(
  db: DrizzleDb,
): Pick<
  TurnRepository,
  | "readTranscriptItems"
  | "countConversationTurns"
  | "findConversationTurnByOrdinal"
  | "findFirstUnsettledTranscriptTurn"
  | "listUnsettledForThread"
  | "listTranscriptBoundaries"
  | "listUnsettledPrimaryTurns"
> {
  // Resolve at call time so snapshot and thread-lock transactions stay ambient.
  const turns = () => currentDrizzleDb(db);
  return {
    async readTranscriptItems(input): Promise<TranscriptItemRow[]> {
      if (input.spans.length === 0 || input.limit <= 0) return [];
      const keyResult = await turns().execute(transcriptItemKeysSql(input));
      const keys = Array.from(keyResult as unknown as Iterable<ItemKey>);
      if (keys.length === 0) return [];
      const turnIds = [...new Set(keys.map((key) => key.turn_id))];
      const blockIds = [...new Set(keys.flatMap((key) => (key.block_id ? [key.block_id] : [])))];
      const turnRows = await turns()
        .select()
        .from(schema.turns)
        .where(inArray(schema.turns.id, turnIds));
      const blockRows =
        input.unit === "turn"
          ? await turns()
              .select()
              .from(schema.turnBlocks)
              .where(inArray(schema.turnBlocks.turnId, turnIds))
          : blockIds.length === 0
            ? []
            : await turns()
                .select()
                .from(schema.turnBlocks)
                .where(inArray(schema.turnBlocks.id, blockIds));
      const turnById = new Map(turnRows.map((row) => [row.id, mapTurn(row)]));
      const blockById = new Map(blockRows.map((row) => [row.id, mapBlock(row)]));
      const blockByTurn = new Map<string, ReturnType<typeof mapBlock>[]>();
      for (const row of blockRows) {
        const block = mapBlock(row);
        const owned = blockByTurn.get(block.turnId) ?? [];
        owned.push(block);
        blockByTurn.set(block.turnId, owned);
      }
      return keys.flatMap((key) => {
        const turn = turnById.get(key.turn_id);
        if (!turn) return [];
        if (input.unit === "turn") {
          const owned = (blockByTurn.get(key.turn_id) ?? []).sort(
            (left, right) => left.sequence - right.sequence,
          );
          return owned.length > 0
            ? owned.map((block) => ({ turn, block, sequence: block.sequence }))
            : [{ turn, block: null, sequence: -1 }];
        }
        return [
          {
            turn,
            block: key.block_id ? (blockById.get(key.block_id) ?? null) : null,
            sequence: key.sequence,
          },
        ];
      });
    },
    async countConversationTurns(spans, beforePosition) {
      if (spans.length === 0) return 0;
      const result = await turns().execute(
        sql`SELECT count(*)::int AS count FROM (${sql.join(conversationTurnBranches(spans, beforePosition), sql` UNION ALL `)}) counted`,
      );
      const [row] = Array.from(result as unknown as Iterable<{ count: number }>);
      return row?.count ?? 0;
    },
    async findConversationTurnByOrdinal(spans, ordinal) {
      if (spans.length === 0 || !Number.isSafeInteger(ordinal) || ordinal < 1) return null;
      const result = await turns().execute(
        sql`SELECT id FROM (${sql.join(conversationTurnBranches(spans), sql` UNION ALL `)}) ordered ORDER BY position ASC OFFSET ${ordinal - 1} LIMIT 1`,
      );
      const [row] = Array.from(result as unknown as Iterable<{ id: string }>);
      if (!row) return null;
      const [turn] = await turns().select().from(schema.turns).where(eq(schema.turns.id, row.id));
      return turn ? mapTurn(turn) : null;
    },
    async findFirstUnsettledTranscriptTurn(spans) {
      if (spans.length === 0) return null;
      const result = await turns().execute(transcriptUnsettledTurnsSql(spans));
      const [row] = Array.from(result as unknown as Iterable<{ id: string }>);
      return row
        ? await turns()
            .select()
            .from(schema.turns)
            .where(eq(schema.turns.id, row.id))
            .then(([turn]) => (turn ? mapTurn(turn) : null))
        : null;
    },
    async listUnsettledForThread(threadId) {
      const rows = await turns()
        .select()
        .from(schema.turns)
        .where(
          sql`${schema.turns.threadId} = ${threadId}::uuid AND ${schema.turns.status} IN ('pending','streaming','waiting_interrupt')`,
        )
        .orderBy(asc(schema.turns.position));
      return rows.map(mapTurn);
    },
    async listTranscriptBoundaries(spans) {
      if (spans.length === 0) return [];
      const result = await turns().execute(transcriptBoundariesSql(spans));
      const ids = Array.from(result as unknown as Iterable<{ id: string }>).map((row) => row.id);
      if (ids.length === 0) return [];
      const rows = await turns().select().from(schema.turns).where(inArray(schema.turns.id, ids));
      const byId = new Map(rows.map((row) => [row.id, mapTurn(row)]));
      return ids.flatMap((id) => {
        const turn = byId.get(id);
        return turn ? [turn] : [];
      });
    },
    async listUnsettledPrimaryTurns(limit, after) {
      const rows = await turns().execute(sql`
        SELECT t.id, t.thread_id, t.position, t.role, t.status
        FROM turns t
        JOIN threads th ON th.id = t.thread_id
        WHERE th.kind = 'primary'
          AND t.role = 'assistant'
          AND t.status IN ('pending','streaming','waiting_interrupt')
          ${after ? sql`AND (t.thread_id, t.position) > (${after.threadId}::uuid, ${after.position}::int)` : sql``}
        ORDER BY t.thread_id ASC, t.position ASC
        LIMIT ${limit}
      `);
      return Array.from(
        rows as unknown as Iterable<{
          id: string;
          thread_id: string;
          position: number;
          role: Turn["role"];
          status: Turn["status"];
        }>,
      ).map((row) => ({
        id: row.id,
        threadId: row.thread_id as Turn["threadId"],
        position: row.position,
        role: row.role,
        status: row.status,
      }));
    },
  };
}
