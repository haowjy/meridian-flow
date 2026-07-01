/**
 * Drizzle ThreadRepository: SQL for the threads table (create with normalization,
 * list/get, soft-delete, and cost recomputation). Thread.workId is projected from
 * the primary thread_works row, not stored on threads.
 */
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import type { TurnRole, TurnStatus } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { and, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
    AND ${schema.turns.status} IN ('pending', 'streaming', 'waiting_interrupt')
  ORDER BY ${schema.turns.createdAt} DESC
  LIMIT 1
)`;

type ThreadListRow = typeof schema.threads.$inferSelect & {
  workId: string | null;
  workTitle: string | null;
  lastTurnRole: TurnRole | null;
  lastTurnStatus: TurnStatus | null;
  runningTurnId: string | null;
  pendingDraftCount: number;
};

function mapThreadListRow(row: ThreadListRow) {
  return toThreadListItem({
    thread: mapThread(row),
    workTitle: row.workTitle,
    lastTurnRole: row.lastTurnRole,
    lastTurnStatus: row.lastTurnStatus,
    runningTurnId: row.runningTurnId,
    pendingDraftCount: row.pendingDraftCount,
  });
}

function pendingDraftCountsSubquery(db: DrizzleDb) {
  return currentDrizzleDb(db)
    .select({
      threadId: schema.documentYjsDrafts.threadId,
      count: sql<number>`COUNT(*)::int`.as("pending_draft_count"),
    })
    .from(schema.documentYjsDrafts)
    .where(eq(schema.documentYjsDrafts.status, "active"))
    .groupBy(schema.documentYjsDrafts.threadId)
    .as("pending_draft_counts");
}

function threadListSelect(draftCounts: ReturnType<typeof pendingDraftCountsSubquery>) {
  return {
    ...getTableColumns(schema.threads),
    workId: schema.threadWorks.workId,
    workTitle: schema.works.title,
    lastTurnRole,
    lastTurnStatus,
    runningTurnId,
    pendingDraftCount: sql<number>`COALESCE(${draftCounts.count}, 0)::int`,
  };
}

function primaryThreadWorksJoin() {
  return and(
    eq(schema.threadWorks.threadId, schema.threads.id),
    eq(schema.threadWorks.isPrimary, true),
  );
}

async function readThreadWriteMode(db: DrizzleDb, id: ThreadId) {
  const [row] = await currentDrizzleDb(db)
    .select({ aiWriteMode: schema.threads.aiWriteMode })
    .from(schema.threads)
    .where(eq(schema.threads.id, id))
    .limit(1);
  return row?.aiWriteMode as "direct" | "draft" | undefined;
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
      totalCostUsd: sql`${schema.threads.totalCostUsd} + ${deltaCostUsd}::numeric`,
      turnCount: sql`${schema.threads.turnCount} + ${turnCountIncrement}`,
      updatedAt: new Date(),
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
          createdByUserId: input.userId as string,
          kind: normalized.kind,
          title: normalized.title,
          composedSystemPrompt: normalized.systemPrompt,
          currentAgentId: normalized.currentAgent,
          aiWriteMode: input.aiWriteMode ?? "direct",
          workingState: input.workingState ?? null,
          parentThreadId: normalized.parentThreadId,
          spawnStatus: normalized.spawnStatus,
          spawnDepth: normalized.spawnDepth,
          status: "idle",
        })
        .returning();
      if (!row) throw new Error("Failed to create thread");
      return mapThread({ ...row, workId: input.workId ?? null });
    },
    async createSubagent(input) {
      const parentAiWriteMode =
        input.aiWriteMode ?? (await readThreadWriteMode(db, input.parentThreadId)) ?? "direct";
      const thread = buildSubagentThreadRow({ ...input, aiWriteMode: parentAiWriteMode });
      const [row] = await currentDrizzleDb(db)
        .insert(schema.threads)
        .values({
          id: thread.id,
          projectId: thread.projectId as ProjectId,
          createdByUserId: thread.userId,
          kind: thread.kind,
          title: thread.title ?? "",
          composedSystemPrompt: thread.composedSystemPrompt,
          bakedSkillSlugs: thread.bakedSkillSlugs,
          systemPromptHash: "baked",
          currentAgentId: thread.currentAgent,
          aiWriteMode: thread.aiWriteMode,
          parentThreadId: thread.parentThreadId,
          originTurnId: input.originTurnId ?? thread.id,
          originType: "spawn",
          spawnStatus: thread.spawnStatus,
          spawnDepth: thread.spawnDepth,
          status: thread.status,
        })
        .returning();
      if (!row) throw new Error("Failed to create subagent thread");
      return mapThread({ ...row, workId: thread.workId });
    },
    async createDerivedPrimary(input) {
      const parentAiWriteMode =
        input.aiWriteMode ?? (await readThreadWriteMode(db, input.parentThreadId)) ?? "direct";
      const thread = buildDerivedPrimaryThreadRow({ ...input, aiWriteMode: parentAiWriteMode });
      const [row] = await currentDrizzleDb(db)
        .insert(schema.threads)
        .values({
          id: thread.id,
          projectId: thread.projectId as ProjectId,
          createdByUserId: thread.userId,
          kind: "primary",
          title: thread.title ?? "",
          composedSystemPrompt: thread.systemPrompt,
          currentAgentId: thread.currentAgent,
          aiWriteMode: thread.aiWriteMode,
          parentThreadId: input.parentThreadId,
          originTurnId: input.originTurnId ?? null,
          originType: input.originType,
          spawnDepth: 0,
          status: thread.status,
        })
        .returning();
      if (!row) throw new Error("Failed to create derived primary thread");
      return mapThread({ ...row, workId: thread.workId });
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
      const primary = await currentDrizzleDb(db)
        .select({ workId: schema.threadWorks.workId })
        .from(schema.threadWorks)
        .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
        .limit(1);
      return mapThread({ ...row, workId: primary[0]?.workId ?? null });
    },
    async findById(id: ThreadId) {
      const [row] = await currentDrizzleDb(db)
        .select({ ...getTableColumns(schema.threads), workId: schema.threadWorks.workId })
        .from(schema.threads)
        .innerJoin(schema.projects, eq(schema.threads.projectId, schema.projects.id))
        .leftJoin(schema.threadWorks, primaryThreadWorksJoin())
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
        .select({ ...getTableColumns(schema.threads), workId: schema.threadWorks.workId })
        .from(schema.threads)
        .innerJoin(schema.projects, eq(schema.threads.projectId, schema.projects.id))
        .leftJoin(schema.threadWorks, primaryThreadWorksJoin())
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
      const draftCounts = pendingDraftCountsSubquery(db);
      const rows = await currentDrizzleDb(db)
        .select(threadListSelect(draftCounts))
        .from(schema.threads)
        .innerJoin(schema.projects, eq(schema.threads.projectId, schema.projects.id))
        .leftJoin(schema.threadWorks, primaryThreadWorksJoin())
        .leftJoin(schema.works, eq(schema.threadWorks.workId, schema.works.id))
        .leftJoin(draftCounts, eq(draftCounts.threadId, schema.threads.id))
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
    async listByWork(projectId: ProjectId, workId: string) {
      const matchedThreadWorks = alias(schema.threadWorks, "matched_thread_works");
      const primaryThreadWorks = alias(schema.threadWorks, "primary_thread_works");
      const primaryWorks = alias(schema.works, "primary_works");
      const draftCounts = pendingDraftCountsSubquery(db);
      const rows = await currentDrizzleDb(db)
        .select({
          ...getTableColumns(schema.threads),
          workId: primaryThreadWorks.workId,
          workTitle: primaryWorks.title,
          lastTurnRole,
          lastTurnStatus,
          runningTurnId,
          pendingDraftCount: sql<number>`COALESCE(${draftCounts.count}, 0)::int`,
        })
        .from(schema.threads)
        .innerJoin(schema.projects, eq(schema.threads.projectId, schema.projects.id))
        .innerJoin(
          matchedThreadWorks,
          and(
            eq(matchedThreadWorks.threadId, schema.threads.id),
            eq(matchedThreadWorks.workId, workId),
          ),
        )
        .leftJoin(
          primaryThreadWorks,
          and(
            eq(primaryThreadWorks.threadId, schema.threads.id),
            eq(primaryThreadWorks.isPrimary, true),
          ),
        )
        .leftJoin(primaryWorks, eq(primaryThreadWorks.workId, primaryWorks.id))
        .leftJoin(draftCounts, eq(draftCounts.threadId, schema.threads.id))
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
    async updateStatus(id, status) {
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({
          status,
          updatedAt: new Date(),
        })
        .where(eq(schema.threads.id, id))
        .returning();
      if (!row) throw new Error(`Thread not found: ${id}`);
      const primary = await currentDrizzleDb(db)
        .select({ workId: schema.threadWorks.workId })
        .from(schema.threadWorks)
        .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
        .limit(1);
      return mapThread({ ...row, workId: primary[0]?.workId ?? null });
    },
    async updateWriteMode(id, aiWriteMode) {
      await currentDrizzleDb(db)
        .update(schema.threads)
        .set({ aiWriteMode, updatedAt: new Date() })
        .where(eq(schema.threads.id, id));
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
      if (!row) return null;
      const primary = await currentDrizzleDb(db)
        .select({ workId: schema.threadWorks.workId })
        .from(schema.threadWorks)
        .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
        .limit(1);
      return mapThread({ ...row, workId: primary[0]?.workId ?? null });
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
      if (row) {
        const primary = await currentDrizzleDb(db)
          .select({ workId: schema.threadWorks.workId })
          .from(schema.threadWorks)
          .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
          .limit(1);
        return mapThread({ ...row, workId: primary[0]?.workId ?? null });
      }
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
      if (existingRow.deletedAt) {
        const primary = await currentDrizzleDb(db)
          .select({ workId: schema.threadWorks.workId })
          .from(schema.threadWorks)
          .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
          .limit(1);
        return mapThread({ ...existingRow, workId: primary[0]?.workId ?? null });
      }
      const now = new Date();
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(schema.threads.id, id))
        .returning();
      if (!row) throw new Error(`Thread not found: ${id}`);
      const primary = await currentDrizzleDb(db)
        .select({ workId: schema.threadWorks.workId })
        .from(schema.threadWorks)
        .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
        .limit(1);
      return mapThread({ ...row, workId: primary[0]?.workId ?? null });
    },
    async restore(id) {
      const [existingRow] = await currentDrizzleDb(db)
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.id, id));
      if (!existingRow) throw new Error(`Thread not found: ${id}`);
      if (!existingRow.deletedAt) {
        const primary = await currentDrizzleDb(db)
          .select({ workId: schema.threadWorks.workId })
          .from(schema.threadWorks)
          .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
          .limit(1);
        return mapThread({ ...existingRow, workId: primary[0]?.workId ?? null });
      }
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(schema.threads.id, id))
        .returning();
      if (!row) throw new Error(`Thread not found: ${id}`);
      const primary = await currentDrizzleDb(db)
        .select({ workId: schema.threadWorks.workId })
        .from(schema.threadWorks)
        .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
        .limit(1);
      return mapThread({ ...row, workId: primary[0]?.workId ?? null });
    },
  };
}
