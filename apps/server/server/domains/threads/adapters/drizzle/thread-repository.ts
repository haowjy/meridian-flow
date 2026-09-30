/**
 * Drizzle ThreadRepository: SQL for the threads table (create with normalization,
 * list/get, soft-delete, and cost recomputation). Thread.workId is projected from
 * the primary thread_works row, not stored on threads.
 */
import { GENERIC_SUBAGENT_NAME } from "@meridian/contracts/agents";
import type { ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type {
  PromptBake,
  SpawnStatus,
  Thread,
  ThreadKind,
  ThreadLifecycleStatus,
} from "@meridian/contracts/threads";
import { formatThreadRef } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { and, asc, desc, eq, getTableColumns, isNotNull, isNull, sql } from "drizzle-orm";
import { runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import { lockThreadAndWorks, lockThreadForMutation } from "../../../../shared/thread-work-lock.js";
import { normalizeThreadCreate } from "../../domain/thread-create.js";
import { buildDerivedPrimaryThreadRow } from "../../domain/thread-create-derived-primary.js";
import { buildSubagentThreadRow } from "../../domain/thread-create-subagent.js";
import { toThreadListItem } from "../../domain/thread-list-projection.js";
import type {
  CreateThreadInput,
  DerivedPrimaryThreadFactory,
  PromptBakeContent,
  SubagentThreadFactory,
  ThreadChild,
  ThreadRepository,
  ThreadStatusReader,
  UpdateSpawnLifecycleInput,
} from "../../ports/repositories.js";
import { mapPromptBake, mapThread } from "./mappers.js";
import { currentDrizzleDb, type DrizzleDatabase, type DrizzleDb } from "./repositories.js";
import { threadActionRequiredSql } from "./visible-conversation-sql.js";
import { workAssociationCandidatesSql } from "./work-association-candidates-sql.js";

// RETURNING strips table qualifiers from Column chunks; preserve the outer reference
// when the binding subquery joins another table with its own id.
const agentDefinitionRevisionId = sql<string | null>`(
  SELECT ${schema.threadAgentBindings.definitionRevisionId}
  FROM ${schema.threadAgentBindings}
  WHERE ${schema.threadAgentBindings.threadId} = ${schema.threads}.${sql.identifier("id")}
)`;

const agentName = sql<string | null>`(
  SELECT
    CASE
      WHEN ${schema.threadAgentBindings.definitionRevisionId} IS NULL
        THEN ${GENERIC_SUBAGENT_NAME}
      ELSE COALESCE(
        ${schema.agentDefinitionRevisions.definition}->'metadata'->>'name',
        ${schema.agentDefinitionRevisions.slug}
      )
    END
  FROM ${schema.threadAgentBindings}
  LEFT JOIN ${schema.agentDefinitionRevisions}
    ON ${schema.agentDefinitionRevisions.id} = ${schema.threadAgentBindings.definitionRevisionId}
  WHERE ${schema.threadAgentBindings.threadId} = ${schema.threads}.${sql.identifier("id")}
)`;

const threadColumns = {
  ...getTableColumns(schema.threads),
  agentDefinitionRevisionId,
  agentName,
};

type ThreadListRow = typeof schema.threads.$inferSelect & {
  workId: string | null;
  workTitle: string | null;
  actionRequired: boolean;
};

function mapThreadListRow(row: ThreadListRow, runningTurnId: string | null) {
  return toThreadListItem({
    thread: mapThread(row),
    workTitle: row.workTitle,
    actionRequired: row.actionRequired,
    runningTurnId,
  });
}

function threadListSelect() {
  return {
    ...threadColumns,
    workId: schema.threadWorks.workId,
    workTitle: schema.works.name,
    actionRequired: threadActionRequiredSql({ activeLeafTurnId: schema.threads.activeLeafTurnId }),
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

async function insertThreadRow(
  db: DrizzleDatabase,
  values: Omit<typeof schema.threads.$inferInsert, "ref" | "kind"> & { kind: ThreadKind },
  options: { ignoreIdConflict?: boolean } = {},
) {
  return runInDrizzleTransaction(db, async () => {
    const activeDb = currentDrizzleDb(db);
    const [counter] = await activeDb
      .insert(schema.projectThreadCounters)
      .values({ projectId: values.projectId as ProjectId, n: 1 })
      .onConflictDoUpdate({
        target: schema.projectThreadCounters.projectId,
        set: { n: sql`${schema.projectThreadCounters.n} + 1` },
      })
      .returning({ n: schema.projectThreadCounters.n });
    if (!counter) throw new Error("Failed to allocate thread ref");
    const ref = formatThreadRef(values.kind, counter.n);
    const insert = activeDb.insert(schema.threads).values({ ...values, ref });
    const [created] = options.ignoreIdConflict
      ? await insert.onConflictDoNothing({ target: schema.threads.id }).returning(threadColumns)
      : await insert.returning(threadColumns);
    return created;
  });
}

export function createDrizzleThreadRepository(
  db: DrizzleDatabase,
  options: { statusReader?: ThreadStatusReader } = {},
): ThreadRepository & SubagentThreadFactory & DerivedPrimaryThreadFactory {
  const statusReader = options.statusReader;
  return {
    async create(input: CreateThreadInput) {
      const normalized = normalizeThreadCreate(input);
      const threadId = input.id ?? crypto.randomUUID();
      const row = await insertThreadRow(db, {
        id: threadId,
        projectId: input.projectId as ProjectId,
        createdByUserId: input.userId as string,
        kind: normalized.kind,
        title: normalized.title,
        parentThreadId: normalized.parentThreadId,
        rootThreadId: threadId,
        spawnStatus: normalized.spawnStatus,
        spawnDepth: normalized.spawnDepth,
        status: "idle",
      });
      if (!row) throw new Error("Failed to create thread");
      return mapThread({ ...row, workId: input.workId ?? null });
    },
    async createSubagent(input) {
      const thread = buildSubagentThreadRow(input);
      const row = await insertThreadRow(db, {
        id: thread.id,
        projectId: thread.projectId as ProjectId,
        createdByUserId: thread.userId,
        kind: thread.kind,
        title: thread.title ?? "",
        initialPromptBakeId: thread.initialPromptBakeId ?? null,
        parentThreadId: thread.parentThreadId,
        rootThreadId: thread.rootThreadId,
        originTurnId: input.originTurnId,
        originType: "spawn",
        spawnStatus: thread.spawnStatus,
        spawnDepth: thread.spawnDepth,
        status: thread.status,
      });
      if (!row) throw new Error("Failed to create subagent thread");
      return mapThread({ ...row, workId: thread.workId });
    },
    async createDerivedPrimary(input) {
      const thread = buildDerivedPrimaryThreadRow(input);
      const row = await insertThreadRow(
        db,
        {
          id: thread.id,
          projectId: thread.projectId as ProjectId,
          createdByUserId: thread.userId,
          kind: "primary",
          title: thread.title ?? "",
          initialPromptBakeId: thread.initialPromptBakeId ?? null,
          parentThreadId: thread.parentThreadId,
          rootThreadId: thread.rootThreadId,
          originTurnId: thread.originTurnId,
          originType: thread.originType,
          spawnDepth: thread.spawnDepth,
          status: thread.status,
        },
        { ignoreIdConflict: true },
      );
      if (row) return { thread: mapThread({ ...row, workId: thread.workId }), created: true };
      const existing = await this.findByIdIncludingDeleted(input.id);
      if (!existing) throw new Error("Derived thread ID conflict disappeared");
      return { thread: existing, created: false };
    },
    async updateSpawnLifecycle(id, input: UpdateSpawnLifecycleInput) {
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({
          spawnStatus: input.spawnStatus,
          updatedAt: new Date(),
        })
        .where(eq(schema.threads.id, id))
        .returning(threadColumns);
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
        .select({
          ...threadColumns,
          workId: schema.threadWorks.workId,
        })
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
    async findByIdIncludingDeleted(id: ThreadId) {
      const [row] = await currentDrizzleDb(db)
        .select({
          ...threadColumns,
          workId: schema.threadWorks.workId,
        })
        .from(schema.threads)
        .leftJoin(schema.threadWorks, primaryThreadWorksJoin())
        .where(eq(schema.threads.id, id));
      return row ? mapThread(row) : null;
    },
    async findLiveByProjectRef(projectId: ProjectId, ref: string) {
      const [row] = await currentDrizzleDb(db)
        .select({
          ...threadColumns,
          workId: schema.threadWorks.workId,
        })
        .from(schema.threads)
        .innerJoin(schema.projects, eq(schema.threads.projectId, schema.projects.id))
        .leftJoin(schema.threadWorks, primaryThreadWorksJoin())
        .where(
          and(
            eq(schema.threads.projectId, projectId),
            eq(schema.threads.ref, ref),
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
    async lockByIdIncludingDeleted(id: ThreadId, additionalWorkIds) {
      const activeDb = currentDrizzleDb(db);
      const locked = additionalWorkIds
        ? await lockThreadAndWorks(db, id, additionalWorkIds)
        : await lockThreadForMutation(db, id);
      if (!locked) return null;
      const [row] = await activeDb
        .select(threadColumns)
        .from(schema.threads)
        .where(eq(schema.threads.id, id))
        .limit(1);
      if (!row) return null;
      const [membership] = await activeDb
        .select({ workId: schema.threadWorks.workId })
        .from(schema.threadWorks)
        .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
        .limit(1);
      return {
        ...mapThread({ ...row, workId: membership?.workId ?? null }),
        deletedByWorkId: row.deletedByWorkId,
      };
    },
    async listByUser(userId: UserId) {
      const rows = await currentDrizzleDb(db)
        .select({
          ...threadColumns,
          workId: schema.threadWorks.workId,
        })
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
        .where(
          and(
            eq(schema.threads.projectId, projectId),
            eq(schema.threads.kind, "primary"),
            isNull(schema.threads.deletedAt),
            isNull(schema.projects.deletedAt),
          ),
        )
        .orderBy(desc(schema.threads.updatedAt));
      // Liveness comes from the lease port for the page, never a second SQL
      // predicate: one implementation of "live" (the lease adapter).
      const leaseStates =
        statusReader && rows.length > 0
          ? await statusReader.readMany(rows.map((row) => row.id as ThreadId))
          : null;
      return rows.map((row) =>
        mapThreadListRow(row, leaseStates?.get(row.id as ThreadId)?.runningTurnId ?? null),
      );
    },
    async listLineageChildren({ rootThreadId, parentIds, limit, after }) {
      const ids = sql.join(
        parentIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const edges = sql`(
        SELECT id, parent_thread_id AS up_thread_id FROM threads
        WHERE parent_thread_id IN (${ids}) AND deleted_at IS NULL
        UNION ALL
        SELECT t.id, cut.thread_id AS up_thread_id FROM threads t
        JOIN turns cut ON cut.id = t.origin_turn_id
        WHERE t.root_thread_id = ${rootThreadId} AND t.origin_type IN ('fork','handoff')
          AND t.deleted_at IS NULL AND cut.thread_id IN (${ids})
      )`;
      const rows = await currentDrizzleDb(db)
        .select({
          ...threadColumns,
          workId: schema.threadWorks.workId,
          upThreadId: sql<ThreadId>`edges.up_thread_id`,
          cursorCreatedAt: sql<string>`to_char(${schema.threads.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          siblingCount: sql<number>`edges.sibling_count::int`,
        })
        .from(schema.threads)
        .innerJoin(
          sql`(SELECT *, count(*) OVER (PARTITION BY up_thread_id) AS sibling_count FROM ${edges} e) edges`,
          sql`edges.id = ${schema.threads.id}`,
        )
        .leftJoin(schema.threadWorks, primaryThreadWorksJoin())
        .where(
          and(
            eq(schema.threads.rootThreadId, rootThreadId),
            after
              ? sql`(${schema.threads.createdAt}, ${schema.threads.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(schema.threads.createdAt), desc(schema.threads.id))
        .limit(limit);
      return rows.map((row) => ({
        ...mapThread(row),
        createdAt: row.cursorCreatedAt,
        upThreadId: row.upThreadId,
        siblingCount: row.siblingCount,
      }));
    },
    async listChildren(threadId: ThreadId) {
      const rows = await currentDrizzleDb(db)
        .select({
          id: schema.threads.id,
          parentThreadId: schema.threads.parentThreadId,
          ref: schema.threads.ref,
          title: schema.threads.title,
          agentName,
          spawnStatus: schema.threads.spawnStatus,
          originTurnId: schema.threads.originTurnId,
        })
        .from(schema.threads)
        .where(
          and(
            eq(schema.threads.parentThreadId, threadId),
            eq(schema.threads.kind, "subagent"),
            isNull(schema.threads.deletedAt),
          ),
        )
        .orderBy(asc(schema.threads.createdAt), asc(schema.threads.id));
      return rows.map(
        (row): ThreadChild => ({
          id: row.id,
          parentThreadId: row.parentThreadId,
          ref: row.ref,
          title: row.title === "" ? null : row.title,
          agentName: row.agentName ?? null,
          spawnStatus: row.spawnStatus as SpawnStatus | null,
          originTurnId: row.originTurnId ?? null,
        }),
      );
    },
    async listRecentByWork(projectId: ProjectId, workId: WorkId, limit: number) {
      const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 50));
      if (boundedLimit === 0) return [];
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH candidates AS (${workAssociationCandidatesSql({
          projectId,
          workId,
          sortColumn: sql`t.updated_at`,
          afterSortAt: null,
          afterThreadId: null,
          limit: boundedLimit,
        })})
        SELECT t.title, t.status,
          to_char(t.updated_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_exact
        FROM candidates JOIN threads t ON t.id = candidates.thread_id
        ORDER BY t.updated_at DESC, t.id DESC
      `);
      return Array.from(
        rows as unknown as Iterable<{
          title: string | null;
          status: ThreadLifecycleStatus;
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
        .returning(threadColumns);
      if (!row) throw new Error(`Thread not found: ${id}`);
      const primary = await currentDrizzleDb(db)
        .select({ workId: schema.threadWorks.workId })
        .from(schema.threadWorks)
        .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
        .limit(1);
      return mapThread({ ...row, workId: primary[0]?.workId ?? null });
    },
    async updateTitle(id, title) {
      const [row] = await currentDrizzleDb(db)
        .update(schema.threads)
        .set({ title, updatedAt: new Date() })
        .where(eq(schema.threads.id, id))
        .returning(threadColumns);
      if (!row) throw new Error(`Thread not found: ${id}`);
      const primary = await currentDrizzleDb(db)
        .select({ workId: schema.threadWorks.workId })
        .from(schema.threadWorks)
        .where(and(eq(schema.threadWorks.threadId, id), eq(schema.threadWorks.isPrimary, true)))
        .limit(1);
      return mapThread({ ...row, workId: primary[0]?.workId ?? null });
    },
    async bakeInitialPrompt(
      id,
      input: PromptBakeContent,
    ): Promise<{ thread: Thread; bake: PromptBake }> {
      return runInDrizzleTransaction(db, async () => {
        const locked = await lockThreadForMutation(db, id);
        if (!locked) throw new Error(`Thread not found: ${id}`);
        const thread = await this.findById(id);
        if (!thread) throw new Error(`Thread not found: ${id}`);
        if (thread.initialPromptBakeId != null) {
          const [row] = await currentDrizzleDb(db)
            .select()
            .from(schema.promptBakes)
            .where(eq(schema.promptBakes.id, thread.initialPromptBakeId));
          if (!row) throw new Error(`Prompt bake not found: ${thread.initialPromptBakeId}`);
          return { thread, bake: mapPromptBake(row) };
        }
        const [bakeRow] = await currentDrizzleDb(db)
          .insert(schema.promptBakes)
          .values({ ownerThreadId: id, ...input })
          .returning();
        if (!bakeRow) throw new Error("Failed to create prompt bake");
        const [updated] = await currentDrizzleDb(db)
          .update(schema.threads)
          .set({ initialPromptBakeId: bakeRow.id, updatedAt: new Date() })
          .where(and(eq(schema.threads.id, id), isNull(schema.threads.initialPromptBakeId)))
          .returning();
        if (!updated) throw new Error(`Thread initial bake changed while locked: ${id}`);
        const current = await this.findById(id);
        if (!current) throw new Error(`Thread not found: ${id}`);
        return { thread: current, bake: mapPromptBake(bakeRow) };
      });
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
        .set({
          deletedAt,
          deletedByWorkId: target === "visible" ? null : undefined,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.threads.id, id),
            target === "deleted"
              ? isNull(schema.threads.deletedAt)
              : isNotNull(schema.threads.deletedAt),
          ),
        )
        .returning(threadColumns);
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
