// @ts-nocheck
/**
 * Drizzle ThreadRepository: SQL for the threads table (create with normalization,
 * list/get, soft-delete, and cost recomputation). Direct lifecycle writes stay
 * separate from projector-driven model-response cost aggregation.
 */
import type { ThreadId, UserId, WorkbenchId, WorkId } from "@meridian/contracts/runtime";
import type { TurnRole, TurnStatus } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { and, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { toIsoString } from "../../domain/contract-serialization.js";
import { normalizeThreadCreate } from "../../domain/thread-create.js";
import { buildSubagentThreadRow } from "../../domain/thread-create-subagent.js";
import { toThreadListItem } from "../../domain/thread-list-projection.js";
import type {
  CreateThreadInput,
  SubagentThreadFactory,
  ThreadRepository,
  UpdateSpawnLifecycleInput,
} from "../../ports/repositories.js";
import { mapThread } from "./mappers.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

const lastTurnRole = sql<TurnRole | null>`(
  SELECT ${schema.turns.role}
  FROM ${schema.turns}
  WHERE ${schema.turns.threadId} = ${schema.threads.id}
  ORDER BY ${schema.turns.createdAt} DESC
  LIMIT 1
)`;

const lastTurnStatus = sql<TurnStatus | null>`(
  SELECT ${schema.turns.status}
  FROM ${schema.turns}
  WHERE ${schema.turns.threadId} = ${schema.threads.id}
  ORDER BY ${schema.turns.createdAt} DESC
  LIMIT 1
)`;

const runningTurnId = sql<string | null>`(
  SELECT ${schema.turns.id}
  FROM ${schema.turns}
  WHERE ${schema.turns.threadId} = ${schema.threads.id}
    AND ${schema.turns.role} = 'assistant'
    AND ${schema.turns.status} IN ('pending', 'streaming', 'waiting_checkpoint')
  ORDER BY ${schema.turns.createdAt} DESC
  LIMIT 1
)`;

type ThreadListRow = typeof schema.threads.$inferSelect & {
  workTitle: string | null;
  lastTurnRole: TurnRole | null;
  lastTurnStatus: TurnStatus | null;
  runningTurnId: string | null;
};

function mapThreadListRow(row: ThreadListRow) {
  return toThreadListItem({
    thread: mapThread(row),
    workTitle: row.workTitle,
    lastTurnRole: row.lastTurnRole,
    lastTurnStatus: row.lastTurnStatus,
    runningTurnId: row.runningTurnId,
  });
}

function threadListSelect() {
  return {
    ...getTableColumns(schema.threads),
    workTitle: schema.works.title,
    lastTurnRole,
    lastTurnStatus,
    runningTurnId,
  };
}

export async function writeThreadCostUpdate(
  db: DrizzleDb,
  id: ThreadId,
  deltaCostUsd: string,
  turnCountIncrement = 0,
) {
  const [row] = await currentDrizzleDb(db)
    .update(schema.threads)
    .set({
      totalCostUsd: sql`${schema.threads.totalCostUsd} + ${deltaCostUsd}`,
      turnCount: sql`${schema.threads.turnCount} + ${turnCountIncrement}`,
      updatedAt: toIsoString(new Date()),
    })
    .where(eq(schema.threads.id, id))
    .returning({ id: schema.threads.id });
  if (!row) throw new Error(`Thread not found: ${id}`);
}

export async function writeThreadCostRecompute(db: DrizzleDb, id: ThreadId) {
  const activeDb = currentDrizzleDb(db);
  const [aggregate] = await activeDb
    .select({
      totalCostUsd: sql<string>`COALESCE(SUM(${schema.modelResponses.costUsd}), 0)::numeric(12,6)`,
    })
    .from(schema.modelResponses)
    .innerJoin(schema.turns, eq(schema.modelResponses.turnId, schema.turns.id))
    .where(eq(schema.turns.threadId, id));

  const [row] = await activeDb
    .update(schema.threads)
    .set({
      totalCostUsd: aggregate?.totalCostUsd ?? "0",
      updatedAt: toIsoString(new Date()),
    })
    .where(eq(schema.threads.id, id))
    .returning({ id: schema.threads.id });
  if (!row) throw new Error(`Thread not found: ${id}`);
}

export function createDrizzleThreadRepository(
  db: DrizzleDb,
): ThreadRepository & SubagentThreadFactory {
  return {
    async create(input: CreateThreadInput) {
      const normalized = normalizeThreadCreate(input);
      const threadId = input.id ?? crypto.randomUUID();
      const [row] = await currentDrizzleDb(db)
        .insert(schema.threads)
        .values({
          id: threadId,
          workbenchId: input.workbenchId,
          ...(input.workId ? { workId: input.workId } : {}),
          createdBy: input.userId as string,
          kind: normalized.kind,
          title: normalized.title,
          composedSystemPrompt: normalized.systemPrompt,
          currentAgent: normalized.currentAgent,
          workingState: input.workingState ?? null,
          parentThreadId: normalized.parentThreadId,
          rootThreadId: threadId,
          spawnStatus: normalized.spawnStatus,
          spawnDepth: normalized.spawnDepth,
          status: "idle",
        })
        .returning();
      if (!row) throw new Error("Failed to create thread");
      return mapThread(row);
    },
    async createSubagent(input) {
      const thread = buildSubagentThreadRow(input);
      const [row] = await currentDrizzleDb(db)
        .insert(schema.threads)
        .values({
          id: thread.id,
          workbenchId: thread.workbenchId,
          ...(thread.workId ? { workId: thread.workId } : {}),
          createdBy: thread.userId,
          kind: thread.kind,
          title: thread.title ?? "",
          composedSystemPrompt: thread.composedSystemPrompt,
          bakedSkillSlugs: thread.bakedSkillSlugs,
          currentAgent: thread.currentAgent,
          parentThreadId: thread.parentThreadId,
          rootThreadId: thread.rootThreadId,
          spawnStatus: thread.spawnStatus,
          spawnDepth: thread.spawnDepth,
          status: thread.status,
        })
        .returning();
      if (!row) throw new Error("Failed to create subagent thread");
      return mapThread(row);
    },
    async updateSpawnLifecycle(id, input: UpdateSpawnLifecycleInput) {
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({
          spawnStatus: input.spawnStatus,
          ...(input.spawnResult !== undefined ? { spawnResult: input.spawnResult } : {}),
          updatedAt: toIsoString(new Date()),
        })
        .where(eq(schema.threads.id, id))
        .returning();
      if (!row) throw new Error(`Thread not found: ${id}`);
      return mapThread(row);
    },
    async findById(id: ThreadId) {
      const [row] = await currentDrizzleDb(db)
        .select(getTableColumns(schema.threads))
        .from(schema.threads)
        .innerJoin(schema.workbenches, eq(schema.threads.workbenchId, schema.workbenches.id))
        .where(
          and(
            eq(schema.threads.id, id),
            isNull(schema.threads.deletedAt),
            isNull(schema.workbenches.deletedAt),
          ),
        );
      return row ? mapThread(row) : null;
    },
    async listByUser(userId: UserId) {
      const rows = await currentDrizzleDb(db)
        .select(getTableColumns(schema.threads))
        .from(schema.threads)
        .innerJoin(schema.workbenches, eq(schema.threads.workbenchId, schema.workbenches.id))
        .where(
          and(
            eq(schema.threads.createdBy, userId),
            isNull(schema.threads.deletedAt),
            isNull(schema.workbenches.deletedAt),
          ),
        )
        .orderBy(desc(schema.threads.updatedAt));
      return rows.map(mapThread);
    },
    async listByWorkbench(workbenchId: WorkbenchId) {
      const rows = await currentDrizzleDb(db)
        .select(threadListSelect())
        .from(schema.threads)
        .innerJoin(schema.workbenches, eq(schema.threads.workbenchId, schema.workbenches.id))
        .leftJoin(schema.works, eq(schema.threads.workId, schema.works.id))
        .where(
          and(
            eq(schema.threads.workbenchId, workbenchId),
            isNull(schema.threads.deletedAt),
            isNull(schema.workbenches.deletedAt),
          ),
        )
        .orderBy(desc(schema.threads.updatedAt));
      return rows.map(mapThreadListRow);
    },
    async listByWork(workbenchId: WorkbenchId, workId: WorkId) {
      const rows = await currentDrizzleDb(db)
        .select(threadListSelect())
        .from(schema.threads)
        .innerJoin(schema.workbenches, eq(schema.threads.workbenchId, schema.workbenches.id))
        .leftJoin(schema.works, eq(schema.threads.workId, schema.works.id))
        .where(
          and(
            eq(schema.threads.workbenchId, workbenchId),
            eq(schema.threads.workId, workId),
            isNull(schema.threads.deletedAt),
            isNull(schema.workbenches.deletedAt),
          ),
        )
        .orderBy(desc(schema.threads.updatedAt));
      return rows.map(mapThreadListRow);
    },
    async updateStatus(id, status) {
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({ status, updatedAt: toIsoString(new Date()) })
        .where(eq(schema.threads.id, id))
        .returning();
      if (!row) throw new Error(`Thread not found: ${id}`);
      return mapThread(row);
    },
    async bakeComposedSystemPrompt(id, input) {
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({
          composedSystemPrompt: input.composedSystemPrompt,
          bakedSkillSlugs: input.bakedSkillSlugs,
          updatedAt: toIsoString(new Date()),
        })
        .where(and(eq(schema.threads.id, id), isNull(schema.threads.bakedSkillSlugs)))
        .returning();
      if (row) return mapThread(row);
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Thread not found: ${id}`);
      return existing;
    },
    async recomputeCostFromModelResponses(id) {
      await writeThreadCostRecompute(db, id);
    },
    async updateCost(id, deltaCostUsd, turnCountIncrement = 0) {
      await writeThreadCostUpdate(db, id, deltaCostUsd, turnCountIncrement);
    },
    async softDelete(id) {
      const [existingRow] = await currentDrizzleDb(db)
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.id, id));
      if (!existingRow) throw new Error(`Thread not found: ${id}`);
      if (existingRow.deletedAt) return mapThread(existingRow);
      const now = toIsoString(new Date());
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(schema.threads.id, id))
        .returning();
      if (!row) throw new Error(`Thread not found: ${id}`);
      return mapThread(row);
    },
    async restore(id) {
      const [existingRow] = await currentDrizzleDb(db)
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.id, id));
      if (!existingRow) throw new Error(`Thread not found: ${id}`);
      if (!existingRow.deletedAt) return mapThread(existingRow);
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({ deletedAt: null, updatedAt: toIsoString(new Date()) })
        .where(eq(schema.threads.id, id))
        .returning();
      if (!row) throw new Error(`Thread not found: ${id}`);
      return mapThread(row);
    },
  };
}
