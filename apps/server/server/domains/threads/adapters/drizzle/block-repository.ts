/** Drizzle BlockRepository: SQL for the thread blocks table (create/list), mapping rows via mappers.ts. Depends inward on the repository port; runs within the shared drizzle-db transaction context. */
import * as schema from "@meridian/database/schema";
import { asc, eq } from "drizzle-orm";
import type {
  BlockRepository,
  CreateBlockInput,
  UpsertBlockInput,
} from "../../ports/repositories.js";
import { mapBlock } from "./mappers.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

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
      return mapBlock(row);
    },
    async upsert(input: UpsertBlockInput) {
      const values = blockValues(input);
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
