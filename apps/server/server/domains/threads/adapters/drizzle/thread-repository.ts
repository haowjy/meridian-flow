/**
 * Drizzle ThreadRepository: SQL for the threads table (create with normalization,
 * list/get, soft-delete, and cost recomputation). Direct lifecycle writes stay
 * separate from projector-driven model-response cost aggregation.
 */
import type { ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { TurnRole, TurnStatus } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { and, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { normalizeThreadCreate } from "../../domain/thread-create.js";
import { buildDerivedPrimaryThreadRow } from "../../domain/thread-create-derived-primary.js";
import { buildSubagentThreadRow } from "../../domain/thread-create-subagent.js";
import { toThreadListItem } from "../../domain/thread-list-projection.js";
import type {
  CreateThreadInput,
  DerivedPrimaryThreadFactory,
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
  _deltaCostUsd: string,
  _turnCountIncrement = 0,
) {
  const [row] = await currentDrizzleDb(db)
    .update(schema.threads)
    .set({
      updatedAt: new Date(),
    })
    .where(eq(schema.threads.id, id))
    .returning({ id: schema.threads.id });
  if (!row) throw new Error(`Thread not found: ${id}`);
}

export async function writeThreadCostRecompute(db: DrizzleDb, id: ThreadId) {
  const activeDb = currentDrizzleDb(db);
  const [row] = await activeDb
    .update(schema.threads)
    .set({
      updatedAt: new Date(),
    })
    .where(eq(schema.threads.id, id))
    .returning({ id: schema.threads.id });
  if (!row) throw new Error(`Thread not found: ${id}`);
}

export function createDrizzleThreadRepository(
  db: DrizzleDb,
): ThreadRepository & SubagentThreadFactory & DerivedPrimaryThreadFactory {
  return {
    async create(input: CreateThreadInput) {
      const normalized = normalizeThreadCreate(input);
      const threadId = input.id ?? crypto.randomUUID();
      const [row] = await currentDrizzleDb(db)
        .insert(schema.threads)
        .values({
          id: threadId,
          projectId: input.projectId as ProjectId,
          workId: input.workId as WorkId,
          createdByUserId: input.userId as string,
          kind: normalized.kind,
          title: normalized.title,
          composedSystemPrompt: normalized.systemPrompt,
          currentAgentId: normalized.currentAgent,
          workingState: input.workingState ?? null,
          parentThreadId: normalized.parentThreadId,
          spawnStatus: normalized.spawnStatus,
          spawnDepth: normalized.spawnDepth,
          status: "active",
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
          projectId: thread.projectId as ProjectId,
          workId: thread.workId as WorkId,
          createdByUserId: thread.userId,
          kind: thread.kind,
          title: thread.title ?? "",
          composedSystemPrompt: thread.composedSystemPrompt,
          bakedSkillSlugs: thread.bakedSkillSlugs,
          systemPromptHash: "baked",
          currentAgentId: thread.currentAgent,
          parentThreadId: thread.parentThreadId,
          originTurnId: input.originTurnId ?? thread.id,
          originType: "spawn",
          spawnStatus: thread.spawnStatus,
          spawnDepth: thread.spawnDepth,
          status: thread.status === "archived" ? "archived" : "active",
        })
        .returning();
      if (!row) throw new Error("Failed to create subagent thread");
      return mapThread(row);
    },
    async createDerivedPrimary(input) {
      const thread = buildDerivedPrimaryThreadRow(input);
      const [row] = await currentDrizzleDb(db)
        .insert(schema.threads)
        .values({
          id: thread.id,
          projectId: thread.projectId as ProjectId,
          workId: thread.workId as WorkId,
          createdByUserId: thread.userId,
          kind: "primary",
          title: thread.title ?? "",
          composedSystemPrompt: thread.systemPrompt,
          currentAgentId: thread.currentAgent,
          parentThreadId: input.parentThreadId,
          originTurnId: input.originTurnId ?? null,
          originType: input.originType,
          spawnDepth: 0,
          status: "active",
        })
        .returning();
      if (!row) throw new Error("Failed to create derived primary thread");
      return mapThread(row);
    },
    async updateSpawnLifecycle(id, input: UpdateSpawnLifecycleInput) {
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({
          spawnStatus: input.spawnStatus,
          ...(input.spawnResult !== undefined ? { spawnResult: input.spawnResult } : {}),
          updatedAt: new Date(),
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
        .innerJoin(schema.projects, eq(schema.threads.projectId, schema.projects.id))
        .where(
          and(
            eq(schema.threads.id, id),
            isNull(schema.threads.deletedAt),
            isNull(schema.projects.deletedAt),
          ),
        );
      return row ? mapThread(row) : null;
    },
    async listByUser(userId: UserId) {
      const rows = await currentDrizzleDb(db)
        .select(getTableColumns(schema.threads))
        .from(schema.threads)
        .innerJoin(schema.projects, eq(schema.threads.projectId, schema.projects.id))
        .where(
          and(
            eq(schema.threads.createdByUserId, userId),
            isNull(schema.threads.deletedAt),
            isNull(schema.projects.deletedAt),
          ),
        )
        .orderBy(desc(schema.threads.updatedAt));
      return rows.map(mapThread);
    },
    async listByProject(projectId: ProjectId) {
      const rows = await currentDrizzleDb(db)
        .select(threadListSelect())
        .from(schema.threads)
        .innerJoin(schema.projects, eq(schema.threads.projectId, schema.projects.id))
        .leftJoin(schema.works, eq(schema.threads.workId, schema.works.id))
        .where(
          and(
            eq(schema.threads.projectId, projectId),
            isNull(schema.threads.deletedAt),
            isNull(schema.projects.deletedAt),
          ),
        )
        .orderBy(desc(schema.threads.updatedAt));
      return rows.map(mapThreadListRow);
    },
    async listByWork(projectId: ProjectId, workId: WorkId) {
      const rows = await currentDrizzleDb(db)
        .select(threadListSelect())
        .from(schema.threads)
        .innerJoin(schema.projects, eq(schema.threads.projectId, schema.projects.id))
        .leftJoin(schema.works, eq(schema.threads.workId, schema.works.id))
        .where(
          and(
            eq(schema.threads.projectId, projectId),
            eq(schema.threads.workId, workId),
            isNull(schema.threads.deletedAt),
            isNull(schema.projects.deletedAt),
          ),
        )
        .orderBy(desc(schema.threads.updatedAt));
      return rows.map(mapThreadListRow);
    },
    async updateStatus(id, status) {
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({
          status: status === "archived" ? "archived" : "active",
          updatedAt: new Date(),
        })
        .where(eq(schema.threads.id, id))
        .returning();
      if (!row) throw new Error(`Thread not found: ${id}`);
      return mapThread(row);
    },
    async updateCurrentAgent(id, currentAgent) {
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({
          currentAgentId: currentAgent,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.threads.id, id),
            isNull(schema.threads.bakedSkillSlugs),
            eq(schema.threads.turnCount, 0),
          ),
        )
        .returning();
      return row ? mapThread(row) : null;
    },
    async bakeComposedSystemPrompt(id, input) {
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({
          composedSystemPrompt: input.composedSystemPrompt,
          bakedSkillSlugs: input.bakedSkillSlugs,
          systemPromptHash: "baked",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.threads.id, id),
            isNull(schema.threads.bakedSkillSlugs),
            input.expectedCurrentAgent === null
              ? isNull(schema.threads.currentAgentId)
              : input.expectedCurrentAgent === undefined
                ? undefined
                : eq(schema.threads.currentAgentId, input.expectedCurrentAgent),
          ),
        )
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
      const now = new Date();
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
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(schema.threads.id, id))
        .returning();
      if (!row) throw new Error(`Thread not found: ${id}`);
      return mapThread(row);
    },
  };
}
