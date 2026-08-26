/**
 * Drizzle ThreadRepository: SQL for the threads table (create with normalization,
 * list/get, soft-delete, and cost recomputation). Thread.workId is projected from
 * the primary thread_works row, not stored on threads.
 */
import type { ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { ThreadStatus, TurnRole, TurnStatus } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { and, desc, eq, getTableColumns, isNotNull, isNull, sql } from "drizzle-orm";
import { runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import { toIsoString } from "../../domain/contract-serialization.js";
import { normalizeThreadCreate } from "../../domain/thread-create.js";
import { buildDerivedPrimaryThreadRow } from "../../domain/thread-create-derived-primary.js";
import { buildSubagentThreadRow } from "../../domain/thread-create-subagent.js";
import { toThreadListItem } from "../../domain/thread-list-projection.js";
import { uniqueThreadSlug } from "../../domain/thread-slug.js";
import type {
  CreateThreadInput,
  DerivedPrimaryThreadFactory,
  SubagentThreadFactory,
  ThreadRepository,
  UpdateSpawnLifecycleInput,
} from "../../ports/repositories.js";
import { mapThread } from "./mappers.js";
import { currentDrizzleDb, type DrizzleDatabase, type DrizzleDb } from "./repositories.js";
import { visibleConversationalHeadLateral } from "./visible-conversation-sql.js";
import { workAssociationCandidatesSql } from "./work-association-candidates-sql.js";

const runningTurnId = sql<string | null>`(
  SELECT ${schema.turns.id}
  FROM ${schema.turns}
  WHERE ${schema.turns.threadId} = ${schema.threads.id}
    AND ${schema.turns.role} = 'assistant'
    AND ${schema.turns.status} IN ('pending', 'streaming')
  ORDER BY ${schema.turns.createdAt} DESC
  LIMIT 1
)`;

type ThreadListRow = typeof schema.threads.$inferSelect & {
  workId: string | null;
  workTitle: string | null;
  lastTurnRole: (typeof schema.turns.$inferSelect)["role"] | null;
  lastTurnStatus: (typeof schema.turns.$inferSelect)["status"] | null;
  lastTurnAt: Date | string | null;
  lastOpenedAt: Date | null;
  manuallyUnread: boolean | null;
  runningTurnId: string | null;
};

function mapThreadListRow(row: ThreadListRow) {
  return toThreadListItem({
    thread: mapThread(row),
    workTitle: row.workTitle,
    lastTurnRole: row.lastTurnRole as TurnRole | null,
    lastTurnStatus: row.lastTurnStatus as TurnStatus | null,
    lastTurnAt: row.lastTurnAt ? toIsoString(row.lastTurnAt) : null,
    lastOpenedAt: row.lastOpenedAt ? toIsoString(row.lastOpenedAt) : null,
    manuallyUnread: row.manuallyUnread ?? false,
    runningTurnId: row.runningTurnId,
  });
}

function threadListSelect() {
  return {
    ...getTableColumns(schema.threads),
    workId: schema.threadWorks.workId,
    workTitle: schema.works.name,
    lastTurnRole: sql<TurnRole | null>`conversational_head.role`,
    lastTurnStatus: sql<TurnStatus | null>`conversational_head.status`,
    lastTurnAt: sql<Date | null>`conversational_head.activity_at`,
    lastOpenedAt: schema.threadUserState.lastOpenedAt,
    manuallyUnread: schema.threadUserState.manuallyUnread,
    runningTurnId,
  };
}

function primaryThreadWorksJoin() {
  return and(
    eq(schema.threadWorks.threadId, schema.threads.id),
    eq(schema.threadWorks.isPrimary, true),
  );
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

async function insertThreadWithStableSlug(
  db: DrizzleDatabase,
  values: typeof schema.threads.$inferInsert,
  title: string | null | undefined,
) {
  return runInDrizzleTransaction(db, async () => {
    const activeDb = currentDrizzleDb(db);
    await activeDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${values.projectId}, 73::bigint))`,
    );
    const rows = await activeDb
      .select({ slug: schema.threads.slug })
      .from(schema.threads)
      .where(
        and(
          eq(schema.threads.projectId, values.projectId as ProjectId),
          isNotNull(schema.threads.slug),
          isNull(schema.threads.deletedAt),
        ),
      );
    const slug = uniqueThreadSlug(
      title,
      rows.flatMap((row) => (row.slug ? [row.slug] : [])),
    );
    const [created] = await activeDb
      .insert(schema.threads)
      .values({ ...values, slug })
      .returning();
    return created;
  });
}

export function createDrizzleThreadRepository(
  db: DrizzleDatabase,
): ThreadRepository & SubagentThreadFactory & DerivedPrimaryThreadFactory {
  return {
    async create(input: CreateThreadInput) {
      const normalized = normalizeThreadCreate(input);
      const threadId = input.id ?? crypto.randomUUID();
      const row = await insertThreadWithStableSlug(
        db,
        {
          id: threadId,
          projectId: input.projectId as ProjectId,
          createdByUserId: input.userId as string,
          kind: normalized.kind,
          title: normalized.title,
          composedSystemPrompt: normalized.systemPrompt,
          currentAgentId: normalized.currentAgent,
          workingState: input.workingState ?? null,
          parentThreadId: normalized.parentThreadId,
          spawnStatus: normalized.spawnStatus,
          spawnDepth: normalized.spawnDepth,
          status: "idle",
        },
        normalized.title,
      );
      if (!row) throw new Error("Failed to create thread");
      return mapThread({ ...row, workId: input.workId ?? null });
    },
    async createSubagent(input) {
      const thread = buildSubagentThreadRow(input);
      const row = await insertThreadWithStableSlug(
        db,
        {
          id: thread.id,
          projectId: thread.projectId as ProjectId,
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
          status: thread.status,
        },
        thread.title,
      );
      if (!row) throw new Error("Failed to create subagent thread");
      return mapThread({ ...row, workId: thread.workId });
    },
    async createDerivedPrimary(input) {
      const thread = buildDerivedPrimaryThreadRow(input);
      const row = await insertThreadWithStableSlug(
        db,
        {
          id: thread.id,
          projectId: thread.projectId as ProjectId,
          createdByUserId: thread.userId,
          kind: "primary",
          title: thread.title ?? "",
          composedSystemPrompt: thread.systemPrompt,
          currentAgentId: thread.currentAgent,
          parentThreadId: input.parentThreadId,
          originTurnId: input.originTurnId ?? null,
          originType: input.originType,
          spawnDepth: 0,
          status: thread.status,
        },
        thread.title,
      );
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
    async findProjectIdByIdIncludingDeleted(id: ThreadId) {
      const [row] = await currentDrizzleDb(db)
        .select({ projectId: schema.threads.projectId })
        .from(schema.threads)
        .where(eq(schema.threads.id, id))
        .limit(1);
      return row?.projectId ?? null;
    },
    async lockByIdIncludingDeleted(id: ThreadId) {
      const [row] = await currentDrizzleDb(db)
        .select({ ...getTableColumns(schema.threads), workId: schema.threadWorks.workId })
        .from(schema.threads)
        .leftJoin(schema.threadWorks, primaryThreadWorksJoin())
        .where(eq(schema.threads.id, id))
        .for("update", { of: schema.threads })
        .limit(1);
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
      const rows = await currentDrizzleDb(db)
        .select(threadListSelect())
        .from(schema.threads)
        .innerJoin(schema.projects, eq(schema.threads.projectId, schema.projects.id))
        .leftJoin(schema.threadWorks, primaryThreadWorksJoin())
        .leftJoin(schema.works, eq(schema.threadWorks.workId, schema.works.id))
        .leftJoin(
          visibleConversationalHeadLateral(sql`${schema.threads.activeLeafTurnId}`),
          sql`true`,
        )
        .leftJoin(
          schema.threadUserState,
          and(
            eq(schema.threadUserState.threadId, schema.threads.id),
            eq(schema.threadUserState.userId, schema.threads.createdByUserId),
          ),
        )
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
    async listRecentByWork(projectId: ProjectId, workId: WorkId, limit: number) {
      const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 50));
      if (boundedLimit === 0) return [];
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH candidates AS (${workAssociationCandidatesSql({
          projectId,
          workId,
          afterSortAt: null,
          afterThreadId: null,
          limit: boundedLimit,
        })})
        SELECT t.title, t.status,
          to_char(candidates.updated_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_exact
        FROM candidates JOIN threads t ON t.id = candidates.thread_id
        ORDER BY candidates.updated_at DESC, candidates.thread_id DESC
      `);
      return Array.from(
        rows as unknown as Iterable<{
          title: string | null;
          status: ThreadStatus;
          updated_at_exact: string;
        }>,
      ).map((row) => ({
        title: row.title,
        status: row.status,
        updatedAt: row.updated_at_exact,
      }));
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
    async setTrashState(id, target) {
      const deletedAt = target === "deleted" ? new Date() : null;
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({ deletedAt, updatedAt: new Date() })
        .where(
          and(
            eq(schema.threads.id, id),
            target === "deleted"
              ? isNull(schema.threads.deletedAt)
              : isNotNull(schema.threads.deletedAt),
          ),
        )
        .returning();
      if (!row) throw new Error(`Thread trash transition requires a changed locked row: ${id}`);
      const primary = await currentDrizzleDb(db)
        .select({ workId: schema.threadWorks.workId })
        .from(schema.threadWorks)
        .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
        .limit(1);
      return mapThread({ ...row, workId: primary[0]?.workId ?? null });
    },
  };
}
