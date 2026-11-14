/**
 * Canonical mutation locks: thread (NO KEY UPDATE), then primary/target Works by id. Several
 * thread rows lock parents first, by `(spawn_depth, id)` (`parentsFirst`), the order lineage
 * cancellation takes a subtree in; any other order deadlocks against a Stop.
 */
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

/**
 * Locks, in id order, the asks these threads hold: live asks and owed continuations. The thread
 * lock takes its own asks first, so an ask transition under it never waits on an ask row.
 * `skipLocked` leaves rows another transaction holds.
 */
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

/** Distinct from the run-ownership lock seed (81); never share a seed across concerns. */
export const THREAD_LOCK_SEED = 82n;

export function threadLockKey(threadId: ThreadId): string {
  return `meridian:thread-lock:${threadId}`;
}

/**
 * The runtime's thread lock (`withThreadLock`), in its order: the thread's held asks, the inbox
 * advisory lock, then the row. A transaction that takes a thread's row and later runs the
 * runtime's lock on it (lineage cancellation) must take it this way, or it inverts against an
 * inbox transaction holding the advisory lock and waiting for the row.
 */
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

/** Caller owns the transaction. FK KEY SHARE from Work notices must remain compatible. */
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

/**
 * The order a thread tree is locked in, by Work lockers and by lineage cancellation within one
 * owner's subtree (cancellation orders the owners themselves, then locks each subtree this way).
 * `spawn_depth` is the parent's plus one, so parents sort before their children;
 * `listSubtreeIds` gives a subtree this order.
 */
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

/** The threads of these Works' primary forests (and, `includeMarked`, those a delete marked). */
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
  /** Each Work's lifecycle, read under its lock. */
  lifecycles: ReadonlyMap<string, LockedWork>;
  threadIds: ThreadId[];
  liveThreadIds: ThreadId[];
  changed: boolean;
};

/**
 * Stabilizes the Works' primary thread forests under the one lock order every Work mutation
 * keeps: all the threads, parents first by `(spawn_depth, id)`; then the Works, by id; then the
 * lineages of those threads and `lineageRootIds`, by root. Several Works are locked together
 * so a transaction that must hold more than one takes each phase across all of them: locking
 * one Work's tree and then the next puts a thread after another's Work, the inversion a delete
 * of that Work deadlocks on. `extraThreadIds` join the thread phase (a chat the caller must
 * hold, which a Work's tree may also contain).
 * `changed` asks the transaction owner to retry instead of letting a newly joined tree escape.
 */
export async function lockWorkThreadTrees(
  db: DrizzleDb,
  workIds: readonly WorkId[],
  options: {
    includeMarked?: boolean;
    /**
     * The Works whose thread forests lock; default `workIds`. A caller that locks Works it
     * only reads (a document's owner) leaves their chats alone.
     */
    threadWorkIds?: readonly WorkId[];
    /**
     * Lock each thread as the runtime does (`lockThreadAsRuntime`), for a caller that later ends
     * threads. Parents first, so the first thread's asks wait and the rest skip rows held
     * elsewhere, as lineage cancellation's later locks do.
     */
    runtimeThreadLock?: boolean;
    extraThreadIds?: readonly ThreadId[];
    lineageRootIds?: readonly string[];
    /**
     * Runs on the tree before its rows lock, receiving the ids parents first (`parentsFirst`); a
     * thread that joins meanwhile reads as `changed`.
     */
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
  // Trashing or restoring the tree changes whether its lineages are live (draft writes decide that
  // under this lock), and it comes before the context namespaces the caller then takes.
  await lockLineagesOfThreads(db, current.threadIds, options.lineageRootIds);
  const initialIds = new Set(initial.threadIds);
  return {
    lifecycles,
    ...current,
    changed: current.threadIds.some((threadId) => !initialIds.has(threadId)),
  };
}

/** `lockWorkThreadTrees` for one Work. */
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

/** Lock every participating Work together, after stabilizing the thread's primary membership. */
export async function lockThreadAndWorks(
  db: DrizzleDb,
  threadId: ThreadId,
  additionalWorkIds: readonly WorkId[] = [],
) {
  const thread = await lockThreadForMutation(db, threadId);
  const activeDb = currentDrizzleDb(db);
  if (!thread) return null;
  // Membership cannot change while the thread row is locked; no snapshot retry is needed.
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
