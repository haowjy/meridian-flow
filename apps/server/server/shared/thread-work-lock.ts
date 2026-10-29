/**
 * Canonical mutation locks: thread (NO KEY UPDATE), then primary/target Works by id. Several
 * thread rows lock parents first, by `(spawn_depth, id)` (`parentsFirst`), the order lineage
 * cancellation takes a subtree in; any other order deadlocks against a Stop.
 */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { asks, threads, threadWorks } from "@meridian/database/schema";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";
import {
  type LockedWorkLifecycle,
  lockWorkLifecycle,
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
        or(inArray(asks.status, ["pending", "open"]), eq(asks.continuation, "pending")),
      ),
    )
    .orderBy(asc(asks.id));
  await (options.skipLocked ? query.for("update", { skipLocked: true }) : query.for("update"));
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
 * The one order every multi-row thread locker takes threads in. `spawn_depth` is the parent's
 * plus one, so parents sort before their children; `listSubtreeIds` gives a subtree this order.
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

async function findWorkThreadTree(
  db: DrizzleDb,
  workId: WorkId,
  includeMarked: boolean,
): Promise<{ threadIds: ThreadId[]; liveThreadIds: ThreadId[] }> {
  const activeDb = currentDrizzleDb(db);
  const roots = await activeDb
    .select(treeColumns)
    .from(threadWorks)
    .innerJoin(threads, eq(threadWorks.threadId, threads.id))
    .where(and(eq(threadWorks.workId, workId), eq(threadWorks.isPrimary, true)));
  const rows = new Map(roots.map((row) => [row.id, row]));
  if (includeMarked) {
    const marked = await activeDb
      .select(treeColumns)
      .from(threads)
      .where(eq(threads.deletedByWorkId, workId));
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
  const ordered = [...rows.values()].sort(parentsFirst);
  return {
    threadIds: ordered.map(({ id }) => id),
    liveThreadIds: ordered.filter(({ deletedAt }) => !deletedAt).map(({ id }) => id),
  };
}

/**
 * Stabilizes a Work's primary thread forest under the canonical thread-before-Work lock order,
 * its rows parents first.
 * `changed` asks the transaction owner to retry instead of letting a newly joined tree escape.
 */
export async function lockWorkThreadTree(
  db: DrizzleDb,
  workId: WorkId,
  options: {
    includeMarked?: boolean;
    /** Runs on the tree before its rows lock; a thread that joins meanwhile reads as `changed`. */
    beforeLock?: (threadIds: readonly ThreadId[]) => Promise<void>;
  } = {},
): Promise<{
  lifecycle: LockedWorkLifecycle;
  threadIds: ThreadId[];
  liveThreadIds: ThreadId[];
  changed: boolean;
}> {
  const initial = await findWorkThreadTree(db, workId, options.includeMarked ?? false);
  await options.beforeLock?.(initial.threadIds);
  for (const threadId of initial.threadIds) await lockThreadForMutation(db, threadId);
  const lifecycle = await lockWorkLifecycle(db, workId);
  const current = await findWorkThreadTree(db, workId, options.includeMarked ?? false);
  const initialIds = new Set(initial.threadIds);
  return {
    lifecycle,
    ...current,
    changed: current.threadIds.some((threadId) => !initialIds.has(threadId)),
  };
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
