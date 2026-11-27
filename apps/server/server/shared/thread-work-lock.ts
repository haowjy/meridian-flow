// Canonical mutation lock order is thread, then Works by id, and threads parents first by `(spawn_depth, id)`; any other order deadlocks against a Stop
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { asks, threads, threadWorks } from "@meridian/database/schema";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { continuationOwedSql } from "./ask-continuation-owed.js";
import { lockLineagesOfThreads } from "./draft-owner.js";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";
import {
  type LockedWork,
  type LockedWorkLifecycle,
  lockWorksInIdOrder,
} from "./work-lifecycle-lock.js";

export async function lockThreadAsks(
  db: DrizzleDb,
  threadIds: readonly ThreadId[],
  options: { skipLocked?: boolean } = {},
) {
  if (threadIds.length === 0) return;
  const query = currentDrizzleDb(db)
    .select({ id: asks.id })
    .from(asks)
    .where(
      and(
        inArray(asks.threadId, [...threadIds]),
        or(inArray(asks.status, ["pending", "open"]), continuationOwedSql()),
      ),
    )
    .orderBy(asc(asks.id));
  await (options.skipLocked ? query.for("update", { skipLocked: true }) : query.for("update"));
}

// Distinct from the run-ownership lock seed (81); never share a seed across concerns
export const THREAD_LOCK_SEED = 82n;

export function threadLockKey(threadId: ThreadId): string {
  return `meridian:thread-lock:${threadId}`;
}

export async function lockThreadAsRuntime(
  db: DrizzleDb,
  threadId: ThreadId,
  options: { skipLockedAsks?: boolean } = {},
) {
  await lockThreadAsks(db, [threadId], { skipLocked: options.skipLockedAsks });
  await currentDrizzleDb(db).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${threadLockKey(threadId)}, ${THREAD_LOCK_SEED}))`,
  );
  return lockThreadForMutation(db, threadId);
}

export async function lockThreadForMutation(db: DrizzleDb, threadId: ThreadId) {
  const activeDb = currentDrizzleDb(db);
  const [thread] = await activeDb
    .select({
      id: threads.id,
      projectId: threads.projectId,
      deletedAt: threads.deletedAt,
      activeLeafTurnId: threads.activeLeafTurnId,
    })
    .from(threads)
    .where(eq(threads.id, threadId))
    .for("no key update");
  return thread ?? null;
}

export function parentsFirst(
  a: { id: string; spawnDepth: number },
  b: { id: string; spawnDepth: number },
): number {
  return a.spawnDepth - b.spawnDepth || a.id.localeCompare(b.id);
}

const treeColumns = {
  id: threads.id,
  deletedAt: threads.deletedAt,
  spawnDepth: threads.spawnDepth,
};

async function findWorkThreadTrees(
  db: DrizzleDb,
  workIds: readonly WorkId[],
  includeMarked: boolean,
  extraThreadIds: readonly ThreadId[],
): Promise<{ threadIds: ThreadId[]; liveThreadIds: ThreadId[] }> {
  const activeDb = currentDrizzleDb(db);
  const roots = workIds.length
    ? await activeDb
        .select(treeColumns)
        .from(threadWorks)
        .innerJoin(threads, eq(threadWorks.threadId, threads.id))
        .where(and(inArray(threadWorks.workId, [...workIds]), eq(threadWorks.isPrimary, true)))
    : [];
  const rows = new Map(roots.map((row) => [row.id, row]));
  if (includeMarked && workIds.length) {
    const marked = await activeDb
      .select(treeColumns)
      .from(threads)
      .where(inArray(threads.deletedByWorkId, [...workIds]));
    for (const row of marked) rows.set(row.id, row);
  }
  let frontier = [...rows.keys()];
  while (frontier.length > 0) {
    const children = await activeDb
      .select(treeColumns)
      .from(threads)
      .where(inArray(threads.parentThreadId, frontier));
    frontier = [];
    for (const child of children) {
      if (rows.has(child.id)) continue;
      rows.set(child.id, child);
      frontier.push(child.id);
    }
  }
  if (extraThreadIds.length) {
    const extras = await activeDb
      .select(treeColumns)
      .from(threads)
      .where(inArray(threads.id, [...extraThreadIds]));
    for (const row of extras) rows.set(row.id, row);
  }
  const ordered = [...rows.values()].sort(parentsFirst);
  return {
    threadIds: ordered.map(({ id }) => id),
    liveThreadIds: ordered.filter(({ deletedAt }) => !deletedAt).map(({ id }) => id),
  };
}

export type LockedWorkThreadTrees = {
  lifecycles: ReadonlyMap<string, LockedWork>;
  threadIds: ThreadId[];
  liveThreadIds: ThreadId[];
  changed: boolean;
};

export async function lockWorkThreadTrees(
  db: DrizzleDb,
  workIds: readonly WorkId[],
  options: {
    includeMarked?: boolean;
    threadWorkIds?: readonly WorkId[];
    runtimeThreadLock?: boolean;
    extraThreadIds?: readonly ThreadId[];
    lineageRootIds?: readonly string[];
    beforeLock?: (threadIds: readonly ThreadId[]) => Promise<void>;
  } = {},
): Promise<LockedWorkThreadTrees> {
  const includeMarked = options.includeMarked ?? false;
  const extraThreadIds = options.extraThreadIds ?? [];
  const threadWorkIds = options.threadWorkIds ?? workIds;
  const initial = await findWorkThreadTrees(db, threadWorkIds, includeMarked, extraThreadIds);
  await options.beforeLock?.(initial.threadIds);
  for (const [index, threadId] of initial.threadIds.entries()) {
    if (options.runtimeThreadLock)
      await lockThreadAsRuntime(db, threadId, { skipLockedAsks: index > 0 });
    else await lockThreadForMutation(db, threadId);
  }
  const lifecycles = await lockWorksInIdOrder(db, workIds);
  const current = await findWorkThreadTrees(db, threadWorkIds, includeMarked, extraThreadIds);
  await lockLineagesOfThreads(db, current.threadIds, options.lineageRootIds);
  const initialIds = new Set(initial.threadIds);
  return {
    lifecycles,
    ...current,
    changed: current.threadIds.some((threadId) => !initialIds.has(threadId)),
  };
}

export async function lockWorkThreadTree(
  db: DrizzleDb,
  workId: WorkId,
  options: Parameters<typeof lockWorkThreadTrees>[2] = {},
): Promise<{
  lifecycle: LockedWorkLifecycle;
  threadIds: ThreadId[];
  liveThreadIds: ThreadId[];
  changed: boolean;
}> {
  const { lifecycles, ...tree } = await lockWorkThreadTrees(db, [workId], options);
  return { lifecycle: lifecycles.get(workId)?.state ?? "missing", ...tree };
}

export async function lockThreadAndWorks(
  db: DrizzleDb,
  threadId: ThreadId,
  additionalWorkIds: readonly WorkId[] = [],
) {
  const thread = await lockThreadForMutation(db, threadId);
  const activeDb = currentDrizzleDb(db);
  if (!thread) return null;
  const [primary] = await activeDb
    .select({ workId: threadWorks.workId })
    .from(threadWorks)
    .where(and(eq(threadWorks.threadId, threadId), eq(threadWorks.isPrimary, true)));
  const workIds = [...new Set([...additionalWorkIds, ...(primary ? [primary.workId] : [])])].sort();
  const locked = await lockWorksInIdOrder(db, workIds);
  const workStates = new Map<WorkId, LockedWorkLifecycle>(
    workIds.map((workId) => [workId, locked.get(workId)?.state ?? "missing"]),
  );
  return { ...thread, primaryWorkId: primary?.workId ?? null, workStates };
}
