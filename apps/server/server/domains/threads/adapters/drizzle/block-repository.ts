/** Drizzle BlockRepository: SQL for the thread blocks table (create/list), mapping rows via mappers.ts. Depends inward on the repository port; runs within the shared drizzle-db transaction context. */

import type { TurnId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { asc, eq, sql } from "drizzle-orm";
import type {
  BlockRepository,
  CreateBlockInput,
  UpsertBlockInput,
} from "../../ports/repositories.js";
import { mapBlock } from "./mappers.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";
import { recomputeThreadChatActivitySql } from "./visible-conversation-sql.js";

function blockValues(input: CreateBlockInput) {
  const textContent = input.textContent ?? null;
  return {
    ...(input.id ? { id: input.id } : {}),
    turnId: input.turnId,
    modelResponseId: input.responseId ?? null,
    blockType: input.blockType,
    sequence: input.sequence,
    provider: input.provider ?? null,
    providerData: input.providerData ?? null,
    content: input.content ?? null,
    modelText: textContent ?? "",
    compact: input.collapsedContent ?? "",
    executionSide: input.executionSide ?? null,
    status: input.status ?? "complete",
  };
}

export function createDrizzleBlockRepository(db: DrizzleDb): BlockRepository {
  return {
    async create(input: CreateBlockInput) {
      const [row] = await currentDrizzleDb(db)
        .insert(schema.turnBlocks)
        .values(blockValues(input))
        .returning();
      if (!row) throw new Error("Failed to create block");
      if (row.blockType === CUSTOM_BLOCK) await recomputeForTurn(db, row.turnId);
      return mapBlock(row);
    },
    async upsert(input: UpsertBlockInput) {
      const values = blockValues(input);
      const [existing] = await currentDrizzleDb(db)
        .select({ turnId: schema.turnBlocks.turnId, blockType: schema.turnBlocks.blockType })
        .from(schema.turnBlocks)
        .where(eq(schema.turnBlocks.id, input.id));
      const [row] = await currentDrizzleDb(db)
        .insert(schema.turnBlocks)
        .values(values)
        .onConflictDoUpdate({
          target: schema.turnBlocks.id,
          set: {
            turnId: values.turnId,
            modelResponseId: values.modelResponseId,
            blockType: values.blockType,
            sequence: values.sequence,
            provider: values.provider,
            providerData: values.providerData,
            content: values.content,
            modelText: values.modelText,
            compact: values.compact,
            executionSide: values.executionSide,
            status: values.status,
          },
        })
        .returning();
      if (!row) throw new Error("Failed to upsert block");
      if (existing?.blockType === CUSTOM_BLOCK && existing.turnId !== row.turnId)
        await recomputeForTurn(db, existing.turnId);
      if (row.blockType === CUSTOM_BLOCK || existing?.blockType === CUSTOM_BLOCK)
        await recomputeForTurn(db, row.turnId);
      return mapBlock(row);
    },
    async findById(id) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(schema.turnBlocks)
        .where(eq(schema.turnBlocks.id, id));
      return row ? mapBlock(row) : null;
    },
    async listByTurn(turnId) {
      const rows = await currentDrizzleDb(db)
        .select()
        .from(schema.turnBlocks)
        .where(eq(schema.turnBlocks.turnId, turnId))
        .orderBy(asc(schema.turnBlocks.sequence));
      return rows.map(mapBlock);
    },
    async listByThread(threadId) {
      const rows = await currentDrizzleDb(db)
        .select({ block: schema.turnBlocks })
        .from(schema.turnBlocks)
        .innerJoin(schema.turns, eq(schema.turnBlocks.turnId, schema.turns.id))
        .where(eq(schema.turns.threadId, threadId))
        .orderBy(asc(schema.turns.createdAt), asc(schema.turnBlocks.sequence));
      return rows.map((row) => mapBlock(row.block));
    },
    async updatePruned(id, pruned) {
      const [row] = await currentDrizzleDb(db)
        .update(schema.turnBlocks)
        .set({ pruned })
        .where(eq(schema.turnBlocks.id, id))
        .returning();
      if (!row) throw new Error(`Block not found: ${id}`);
      return mapBlock(row);
    },
  };
}

/**
 * Blocks decide a turn's visibility only when a system turn carries a custom
 * block, so only custom blocks move a chat's activity. Streaming text and tool
 * blocks skip the recompute.
 */
const CUSTOM_BLOCK = "custom";

async function recomputeForTurn(db: DrizzleDb, turnId: string) {
  const [turn] = await currentDrizzleDb(db)
    .select({ threadId: schema.turns.threadId })
    .from(schema.turns)
    .where(eq(schema.turns.id, turnId as TurnId));
  if (turn) {
    await currentDrizzleDb(db).execute(recomputeThreadChatActivitySql(sql`${turn.threadId}::uuid`));
  }
}
