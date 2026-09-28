/** Indexed keyset reads for effective transcript spans. */

import type { Turn } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type {
  ReadTranscriptItemsInput,
  TranscriptItemRow,
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
      const compare = input.order === "newest_first" ? sql`<` : sql`>`;
      positionConditions.push(
        input.unit === "item"
          ? sql`(t.position ${compare} ${input.after.position} OR t.position = ${input.after.position})`
          : sql`t.position ${compare} ${input.after.position}`,
      );
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

    return sql`(
      SELECT t.id AS turn_id, t.position,
        COALESCE(b.sequence, -1)::int AS sequence, b.id AS block_id
      FROM (
        SELECT t.id, t.thread_id, t.position
        FROM turns t
        WHERE ${sql.join(positionConditions, sql` AND `)}
        ORDER BY t.position ${direction}
        LIMIT ${input.limit + 1}
      ) t
      LEFT JOIN LATERAL (
        SELECT b.id, b.sequence
        FROM turn_blocks b
        WHERE b.turn_id = t.id
          ${input.through ? sql`AND (t.position <> ${input.through.position} OR b.sequence <= ${input.through.sequence})` : sql``}
          ${input.after ? sql`AND (t.position <> ${input.after.position} OR b.sequence ${input.order === "newest_first" ? sql`<` : sql`>`} ${input.after.sequence})` : sql``}
        ORDER BY b.sequence ${direction}
        LIMIT ${input.limit + 1}
      ) b ON TRUE
      WHERE ${input.through ? sql`(t.position < ${input.through.position} OR (t.position = ${input.through.position} AND COALESCE(b.sequence, -1) <= ${input.through.sequence}))` : sql`TRUE`}
        AND ${input.after ? sql`(t.position ${input.order === "newest_first" ? sql`<` : sql`>`} ${input.after.position} OR (t.position = ${input.after.position} AND COALESCE(b.sequence, -1) ${input.order === "newest_first" ? sql`<` : sql`>`} ${input.after.sequence}))` : sql`TRUE`}
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

export function createDrizzleTranscriptReader(
  db: DrizzleDb,
): Pick<
  TurnRepository,
  | "readTranscriptItems"
  | "findFirstUnsettledTranscriptTurn"
  | "listUnsettledForThread"
  | "listTranscriptBoundaries"
  | "listUnsettledPrimaryTurns"
> {
  const turns = currentDrizzleDb(db);
  return {
    async readTranscriptItems(input): Promise<TranscriptItemRow[]> {
      if (input.spans.length === 0 || input.limit <= 0) return [];
      const keyResult = await turns.execute(transcriptItemKeysSql(input));
      const keys = Array.from(keyResult as unknown as Iterable<ItemKey>);
      if (keys.length === 0) return [];
      const turnIds = [...new Set(keys.map((key) => key.turn_id))];
      const blockIds = [...new Set(keys.flatMap((key) => (key.block_id ? [key.block_id] : [])))];
      const turnRows = await turns
        .select()
        .from(schema.turns)
        .where(inArray(schema.turns.id, turnIds));
      const blockRows =
        input.unit === "turn"
          ? await turns
              .select()
              .from(schema.turnBlocks)
              .where(inArray(schema.turnBlocks.turnId, turnIds))
          : blockIds.length === 0
            ? []
            : await turns
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
    async findFirstUnsettledTranscriptTurn(spans) {
      if (spans.length === 0) return null;
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
      const result = await turns.execute(sql`
        SELECT id FROM (${sql.join(branches, sql` UNION ALL `)}) unsettled
        ORDER BY position ASC LIMIT 1
      `);
      const [row] = Array.from(result as unknown as Iterable<{ id: string }>);
      return row
        ? await turns
            .select()
            .from(schema.turns)
            .where(eq(schema.turns.id, row.id))
            .then(([turn]) => (turn ? mapTurn(turn) : null))
        : null;
    },
    async listUnsettledForThread(threadId) {
      const rows = await turns
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
      const result = await turns.execute(
        sql`SELECT id FROM (${sql.join(branches, sql` UNION ALL `)}) boundaries ORDER BY position ASC`,
      );
      const ids = Array.from(result as unknown as Iterable<{ id: string }>).map((row) => row.id);
      if (ids.length === 0) return [];
      const rows = await turns.select().from(schema.turns).where(inArray(schema.turns.id, ids));
      const byId = new Map(rows.map((row) => [row.id, mapTurn(row)]));
      return ids.flatMap((id) => {
        const turn = byId.get(id);
        return turn ? [turn] : [];
      });
    },
    async listUnsettledPrimaryTurns(limit, after) {
      const rows = await turns.execute(sql`
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
